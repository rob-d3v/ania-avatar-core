/**
 * MotionMatcher — deterministic frame selection for a frame-bank avatar.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/matcher.py`.
 * See that file's docstring and `wiki/concepts/ania-2-0-pose-descriptor-and-motion-graph.md`
 * for the full spec (cost space, modes, teleport gate, etc). Pure module: no DOM,
 * no wall clock (time is injected), no RNG — identical semantics to the Python are
 * pinned by the parity fixtures under `AniaAPP/tests/fixtures/mocap`.
 */

import { DESCRIPTOR_VERSION, NDIMS, NEUTRAL, RETARGET, WEIGHTS, G_MOUTH, DIM_INDEX, groupVector } from './descriptor';
import type { OneEuroVector } from './one-euro';

/**
 * §6 rule 4 ("never exceed the bank's own head range by more than 30 %"): the
 * retarget clamp is ±10 % of the span for every dim and ±30 % for the two head angles.
 */
export const RETARGET_OVERSHOOT: Float64Array = (() => {
  const a = new Float64Array(NDIMS).fill(0.1);
  a[DIM_INDEX.headYaw] = 0.3;
  a[DIM_INDEX.headPitch] = 0.3;
  return a;
})();

/** §4.5 expression hold — one-sided dims only; blinks, head, body and hands must be fast. */
export const HOLD_DIMS: readonly number[] = [
  DIM_INDEX.mouthSmile,
  DIM_INDEX.eyeWide,
  DIM_INDEX.browInnerUp,
  DIM_INDEX.mouthFrown,
  DIM_INDEX.mouthPucker,
];
/** Held only under `mouth_policy = "mocap"` (the camera owns the mouth). */
export const HOLD_DIM_MOUTH_OPEN = DIM_INDEX.mouthOpen;

const BLINK_L = DIM_INDEX.eyeBlinkL;
const BLINK_R = DIM_INDEX.eyeBlinkR;
const MOUTH_OPEN = DIM_INDEX.mouthOpen;
const JAW_OPEN = DIM_INDEX.jawOpen;

/** Dims the ARTICULATE sub-state amplifies / attenuates. */
export const ARTICULATE_MOUTH_DIMS: readonly number[] = [
  DIM_INDEX.mouthOpen,
  DIM_INDEX.jawOpen,
  DIM_INDEX.mouthWidth,
  DIM_INDEX.mouthPucker,
];
export const ARTICULATE_HEAD_DIMS: readonly number[] = [DIM_INDEX.headYaw, DIM_INDEX.headPitch, DIM_INDEX.headRoll];

/** Head bins for the blink search — the same edges `coverage.json` uses. */
export const BLINK_YAW_EDGES: readonly number[] = [-1.0, -0.6, -0.3, -0.1, 0.1, 0.3, 0.6, 1.0];
export const BLINK_PITCH_EDGES: readonly number[] = [-1.0, -0.5, -0.15, 0.15, 0.5, 1.0];

function binOf(value: number, edges: readonly number[]): number {
  for (let b = 0; b < edges.length - 1; b++) if (value < edges[b + 1]) return b;
  return edges.length - 2;
}

export const MODE_LIVE = 'LIVE';
export const MODE_DECAY = 'DECAY';
export const MODE_IDLE = 'IDLE';
export const SEQ_IDLE = 0;
export const SEQ_TALK = 1;
export const SEQ_OTHER = 2;

export const KIND_KNN = 0;
export const KIND_SUCC = 1;
export const KIND_PRED = 2;
export const KIND_HUB = 3;

export class MatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatcherError';
    Object.setPrototypeOf(this, MatcherError.prototype);
  }
}

export interface StepResult {
  frame: number;
  mode: string;
  preload: number[];
  handoff: boolean;
  teleport: boolean;
  /** `c(prev, next)`: 0 natural, the graph cost for an edge, or `c_jump` for a teleport. */
  transition_cost: number;
  /** Idle micro-motion is running (reaction levels §4.4). */
  breathing: boolean;
  /** This frame was forced by the blink priority event. */
  blink: boolean;
  /** The mouth is the primary objective this tick (ARTICULATE). */
  articulating: boolean;
  debug: Record<string, number>;
}

/**
 * Field names match the Python `MatcherOptions` dataclass verbatim (snake_case)
 * rather than TS convention, so a `poses.json`/options JSON produced for the
 * Python side can be passed to `new MotionMatcher(...)` unchanged.
 */
export interface MatcherOptions {
  w_t: number;
  c_jump: number;
  w_a_mocap: number;
  w_a_audio: number;
  /** `"audio"` | `"mocap"` | `"auto"` (reaction levels §4.3). */
  mouth_policy: 'audio' | 'mocap' | 'auto';
  stale_ms: number;
  idle_after_ms: number;
  decay_tau_ms: number;
  teleport_cooldown_ms: number;
  teleport_min_gain: number;
  /** `false` == `teleport_min_gain = +Infinity` (level `presence`). */
  allow_teleport: boolean;
  min_run_ticks: number;
  recent_len: number;
  global_m: number;
  global_search_every: number;
  hold_free_ticks: number;
  hold_penalty_per_tick: number;
  hold_penalty_max: number;
  step_penalty: number;
  cache_penalty: number;
  lookahead_w: number;
  allow_skip: boolean;
  skip_gain: number;
  idle_handoff_ticks: number;
  gap_ema_tau_ms: number;
  /** Python-only float64-vs-float32 toggle; JS numbers are always float64, so
   * this is accepted for wire compatibility but has no effect here. */
  parity_strict?: boolean;

  // ---- reaction levels (see levels.ts). Every one of these is inert at its default,
  // so a matcher built without a level behaves exactly as it did before they existed.
  /** Per-dim multiplier on `WEIGHTS` (§2.1). A gain of 0 drops the dim from both the
   * numerator and the denominator, so `E_best` stays comparable between levels. */
  dim_gain?: ArrayLike<number> | null;
  /** Retarget onto `ranges.reach` instead of p05/p95. */
  use_reach: boolean;
  /** level gain × intensity (§2.3). */
  retarget_gain: number;
  /** `caps.mouth`: arms the `auto` handover. */
  mouth_camera_allowed: boolean;
  /** §4.3 silence hysteresis before the camera takes the mouth. */
  mouth_handover_ms: number;
  /** §6 rule 1 wins over `mouth_policy = "mocap"`. */
  talking_forces_audio: boolean;
  /** §4.5 expression hold (0 = off). */
  hold_ms: number;
  hold_release_ms: number;
  /** §4.4 idle micro-motion. */
  breathing: boolean;
  breathing_dwell_ticks: number;
  breathing_bonus: number;

  // ---- blink priority event.
  // "Pisquei e ela pisca... mas parou": a blink lasts ~150 ms and the run hysteresis holds
  // a frame for min_run ticks (160 ms at `presence`), so the eye-closed frame is usually
  // outranked by the step penalty and skipped. A blink is not a pose to be matched, it is
  // an EVENT: on the rising edge the matcher jumps straight to an eye-closed frame,
  // bypassing min_run and the teleport gate, holds it two ticks and resumes. Off by
  // default (legacy parity); every level turns it on.
  blink_event: boolean;
  blink_threshold: number;
  /** What counts as "eye closed" in the bank. */
  blink_frame_threshold: number;
  blink_refractory_ms: number;
  blink_hold_ticks: number;

  // ---- ARTICULATE sub-state.
  // "Ela tá só sorrindo quando eu falo, em vez de articular de fato a boca": the MOUTH
  // dims weigh ~1 against HEAD 3/2/1.5, so once the head is matched the matcher stays in
  // that frame's neighbourhood and the mouth only drifts among neighbours — and on a bank
  // that smiles in 80 % of its frames, every neighbour is a smile. While the camera (or
  // the mic) says the user is SPEAKING, the mouth becomes the primary objective inside the
  // current head bin. Off by default; the levels with a camera mouth turn it on.
  articulate: boolean;
  articulate_window_ms: number;
  articulate_var_threshold: number;
  articulate_rise: number;
  articulate_hold_ms: number;
  articulate_mouth_gain: number;
  articulate_head_gain: number;
  /** Head bins around the current one. */
  articulate_bin_slack: number;
  articulate_step_penalty: number;

  /**
   * Where the mouth-OPEN value comes from once the user owns the mouth: `"camera"` the
   * webcam's MAR only, `"mic"` the microphone envelope only, `"hybrid"`
   * `max(mic, camera × 0.6)` — the mic wins when the user speaks, the camera still
   * carries a silent open mouth. Smile / width / pucker are always the camera's.
   */
  mouth_blend: 'camera' | 'mic' | 'hybrid';
  mouth_camera_weight: number;
  /**
   * Which frames the matcher may show.
   *
   * `all` is the legacy-parity default: every frame of the bank is a candidate.
   * `legacy` restricts the search to the avatar's OWN frames — the ones inside its
   * `idle` / `talk` / `action:*` sequences — and locks out everything an Ania 2.0
   * coverage upgrade appended (indexed as `orphan:*`), plus any range in
   * `excluded_ranges`. 2026-09-05: the live session walked into that generated block
   * and the result was "os quadros mais aleatórios do mundo" — a different render, a
   * camera in frame, and the talk range never reached again.
   */
  frame_pool: 'legacy' | 'all';
  /**
   * Extra frame ranges to lock out, as inclusive `[low, high]` pairs — the manifest's
   * `video.ania2.coverage` block, handed in by the host.
   */
  excluded_ranges?: ArrayLike<ArrayLike<number>> | null;
}

export const DEFAULT_MATCHER_OPTIONS: MatcherOptions = {
  w_t: 0.01,
  c_jump: 8.0,
  w_a_mocap: 0.1,
  w_a_audio: 0.3,
  mouth_policy: 'audio',
  stale_ms: 400.0,
  idle_after_ms: 3000.0,
  // 3·tau = 390 ms to 95 %: "decay to neutral within 400 ms when tracking is lost"
  // (reaction levels §6 rule 5). The old 1500 ms left a face frozen mid-expression
  // for four and a half seconds after the user walked away.
  decay_tau_ms: 130.0,
  teleport_cooldown_ms: 500.0,
  teleport_min_gain: 0.15,
  allow_teleport: true,
  min_run_ticks: 3,
  recent_len: 8,
  global_m: 8,
  global_search_every: 1,
  hold_free_ticks: 6,
  hold_penalty_per_tick: 0.002,
  hold_penalty_max: 0.012,
  step_penalty: 0.001,
  cache_penalty: 0.1,
  lookahead_w: 0.5,
  allow_skip: true,
  skip_gain: 0.002,
  idle_handoff_ticks: 10,
  gap_ema_tau_ms: 1000.0,
  parity_strict: false,
  dim_gain: null,
  use_reach: false,
  retarget_gain: 1.0,
  mouth_camera_allowed: true,
  mouth_handover_ms: 250.0,
  talking_forces_audio: false,
  hold_ms: 0.0,
  hold_release_ms: 150.0,
  breathing: false,
  breathing_dwell_ticks: 25,
  breathing_bonus: 0.004,
  blink_event: false,
  blink_threshold: 0.6,
  blink_frame_threshold: 0.6,
  blink_refractory_ms: 250.0,
  blink_hold_ticks: 2,
  articulate: false,
  articulate_window_ms: 300.0,
  articulate_var_threshold: 0.004,
  articulate_rise: 0.15,
  articulate_hold_ms: 400.0,
  articulate_mouth_gain: 4.0,
  articulate_head_gain: 0.5,
  articulate_bin_slack: 1,
  articulate_step_penalty: 0.0005,
  mouth_blend: 'hybrid',
  mouth_camera_weight: 0.6,
  // `all` keeps a matcher built the old way byte-identical: every parity fixture is
  // scored on the unfiltered pool.
  frame_pool: 'all',
  excluded_ranges: null,
};

/** `ania.poses` bank (`poses.json`), as consumed by {@link MotionMatcher}. */
export interface PosesBank {
  descriptorVersion: number;
  dims?: number;
  frameCount: number;
  data: ArrayLike<number>;
  mask?: ArrayLike<number>;
  dimValid?: ArrayLike<number>;
  neutral?: ArrayLike<number>;
  ranges?: {
    p05?: ArrayLike<number>;
    p95?: ArrayLike<number>;
    /** `index.build_reach`: the range the bank can actually *show*. */
    reach?: { lo?: ArrayLike<number>; hi?: ArrayLike<number> } | null;
  };
  restFrame?: number;
  seq?: { name: string; low: number; high: number }[];
  frameSeq?: ArrayLike<number>;
  cuts?: ArrayLike<number>;
  [key: string]: unknown;
}

/** `motion_graph.json` CSR, as consumed by {@link MotionMatcher}. */
export interface MotionGraph {
  offsets: ArrayLike<number>;
  to: ArrayLike<number>;
  cost: ArrayLike<number>;
  kind?: ArrayLike<number>;
  restFrame?: number;
  [key: string]: unknown;
}

/** Bundle passed to `AnimationController.configureMocap`. */
export interface MocapIndex {
  poses: PosesBank;
  motionGraph?: MotionGraph | null;
  options?: Partial<MatcherOptions>;
}

/** Wire message pushed via `AnimationController.pushPose`. */
export interface PoseDescriptorMessage {
  v: 1;
  t: number;
  mask: number;
  norm?: 'raw' | 'cal';
  d: ArrayLike<number>;
}

/**
 * Is this sequence part of the avatar the creator authored?
 *
 * `index.sequencesFromRanges` names the author's ranges `idle` / `talk` /
 * `action:<name>` and every contiguous leftover `orphan:<k>`. Frames appended by an
 * Ania 2.0 coverage upgrade fall outside all the authored ranges, so they land in the
 * orphans — which is exactly what `frame_pool: "legacy"` excludes.
 */
/**
 * The dims the start-point bias scores on, with their weights: the smile and the head.
 * Four channels, not the whole descriptor — the bias fires at a cut point, where the
 * engine was about to jump anyway, and these are what a viewer reads as "she reacted".
 */
const START_POINT_DIMS: readonly (readonly [number, number])[] = [
  [DIM_INDEX.mouthSmile, 1.0],
  [DIM_INDEX.headYaw, 1.0],
  [DIM_INDEX.headPitch, 0.5],
];

function seqIsLegacy(name: string): boolean {
  const n = (name || '').toLowerCase();
  return n.startsWith('idle') || n.startsWith('talk') || n.startsWith('action');
}

function seqKind(name: string): number {
  const n = (name || '').toLowerCase();
  if (n.startsWith('idle')) return SEQ_IDLE;
  if (n.startsWith('talk')) return SEQ_TALK;
  return SEQ_OTHER;
}

/** Lexicographic compare of two equal-length numeric keys. */
function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Lexicographic compare of the `(cost, tie, j)` selection key. */
function keyLess(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/** Ascending by `(S[idx], idx)`, treating `Infinity === Infinity` correctly
 * (a naive `S[a] - S[b]` comparator produces `NaN` on `Infinity - Infinity`). */
function byScoreThenIndex(S: Float64Array): (a: number, b: number) => number {
  return (a, b) => {
    if (S[a] < S[b]) return -1;
    if (S[a] > S[b]) return 1;
    return a - b;
  };
}

export class MotionMatcher {
  public readonly opt: MatcherOptions;
  public readonly N: number;

  private readonly F: Float64Array; // N x NDIMS, row-major
  private readonly Vmat: Float64Array; // N x NDIMS, row-major
  private readonly dimValid: Float64Array;
  private readonly weights: Float64Array;
  private readonly neutral: Float64Array;
  private readonly p05: Float64Array;
  private readonly p95: Float64Array;
  /** Per-dim multiplier applied to `WEIGHTS` before scoring (reaction levels §2.1). */
  public readonly dimGain: Float64Array;
  /** `ranges.reach.lo` (or p05 when the bank carries no reach). */
  public readonly reachLo: Float64Array;
  /** `ranges.reach.hi` (or p95 when the bank carries no reach). */
  public readonly reachHi: Float64Array;
  /** Whether the bank actually carried a `ranges.reach` block. */
  public readonly hasReach: boolean;
  private restFrame: number;

  private readonly seqOf: Int32Array;
  private readonly seqKindOf: Int32Array;
  /** 1 where the frame sits in a sequence the creator authored (idle/talk/action). */
  private readonly seqLegacyOf: Uint8Array;
  /** 1 where the frame may be shown at all (`frame_pool` + `excluded_ranges`). */
  public readonly allowed: Uint8Array;
  private readonly kindIndex: Record<number, number[]>;
  private readonly cutAfter: Uint8Array;

  private readonly offsets: Int32Array;
  private readonly to: Int32Array;
  private readonly cost: Float64Array;
  private readonly edgeCost: Map<number, number>;

  private oneEuro: OneEuroVector | null;

  // ---- mutable state (see reset()) ----
  private xHat!: Float64Array;
  private maskLive = 0;
  private lastPoseAt: number | null = null;
  private lastStepAt: number | null = null;
  private talking = false;
  private envelope = 0;
  private intensity = 0.6;
  private recent: number[] = [];
  private runTicks = 0;
  private dwellTicks = 0;
  private lastTeleportAt = -1e12;
  private idleTicks = 0;
  private tick = 0;
  private lastS: Float64Array | null = null;
  private lastDen: Float64Array | null = null;
  private lastGlobal: number[] = [];
  private denCacheMask = -1;
  private denCache: Float64Array | null = null;
  private emaEBest = 0;
  /** Visual cost of the transition actually taken on the last `step` (§4.2 crossfade input). */
  public lastTransitionCost = 0;
  /** Whether the last `step` was running the §4.4 idle micro-motion. */
  public breathingActive = false;
  private silenceSince: number | null = null;
  private mouthPolicyEff: 'audio' | 'mocap' = 'audio';
  /**
   * Which policy actually owned the mouth on the last step (`audio` | `mocap`) — the
   * §4.3 handover as it resolved, not as it was configured. Read by the parity fixture,
   * which records it per tick, and by the HUD.
   *
   * Distinct from {@link mouthSource}, which answers "did the AVATAR's audio or the
   * user's CAMERA supply the value" and is spelled `audio` | `camera`.
   */
  get mouthPolicy(): 'audio' | 'mocap' {
    return this.mouthPolicyEff;
  }

  private holdPeak!: Float64Array;
  private holdT!: Float64Array;
  private holdInit!: Uint8Array;
  /** Frames of this bank whose eyes are closed, and their head bins. */
  private readonly blinkFrames: Int32Array;
  private readonly yawBin: Int32Array;
  private readonly pitchBin: Int32Array;
  /** Optional per-frame openness (the legacy lip-sync map), NaN where unknown. */
  private openness: Float64Array;
  private hasOpenness = false;
  /** Wall-clock-free blink state. */
  public lastBlinkAt = -1e12;
  public blinkEvents = 0;
  private blinkPrev = 0;
  private blinkHold = 0;
  /** ARTICULATE state. */
  public articulating = false;
  public articulateUntil = -1e12;
  public micOpenness: number | null = null;
  /** When the last mic sample was pushed, or `null` if the caller never timestamps. */
  private micPushedAt: number | null = null;
  private mouthHist: [number, number][] = [];

  constructor(poses: PosesBank, graph?: MotionGraph | null, options?: Partial<MatcherOptions>, oneEuro?: OneEuroVector | null) {
    this.opt = { ...DEFAULT_MATCHER_OPTIONS, ...(options || {}) };
    if (Number(poses.descriptorVersion) !== DESCRIPTOR_VERSION) {
      throw new MatcherError(`descriptorVersion ${poses.descriptorVersion} != ${DESCRIPTOR_VERSION}`);
    }
    const n = Math.trunc(Number(poses.frameCount));
    const dims = Math.trunc(Number(poses.dims ?? NDIMS));
    const data = Float64Array.from(poses.data);
    this.N = n;

    this.F = new Float64Array(n * NDIMS);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < dims; d++) {
        // A bank row is data from disk: one non-finite entry would make every
        // cost against that frame NaN. Treat it as "not measured" (0, the value
        // an unset dim already has) rather than letting it into the cost space.
        const v = data[i * dims + d];
        this.F[i * NDIMS + d] = Number.isFinite(v) ? v : 0;
      }
    }

    const masks = poses.mask ? Int32Array.from(poses.mask) : new Int32Array(n).fill(0xff);
    const dimValid = new Float64Array(NDIMS).fill(1);
    if (poses.dimValid) {
      const dv = Float64Array.from(poses.dimValid);
      for (let i = 0; i < NDIMS; i++) dimValid[i] = i < dv.length ? dv[i] : 0;
    }
    this.dimValid = dimValid;

    this.Vmat = new Float64Array(n * NDIMS);
    for (let i = 0; i < n; i++) {
      const gv = groupVector(masks[i]);
      for (let d = 0; d < NDIMS; d++) this.Vmat[i * NDIMS + d] = gv[d] * dimValid[d];
    }

    // The level never edits WEIGHTS; it supplies a per-dim gain and the matcher scores
    // with w_i = WEIGHTS[i] * dimGain[i]. A gain of 0 leaves the dim out of both the
    // numerator and the denominator (identical to clearing its group bit), so E_best
    // stays comparable between levels.
    this.dimGain = new Float64Array(NDIMS).fill(1);
    if (this.opt.dim_gain) {
      const dg = this.opt.dim_gain;
      for (let i = 0; i < Math.min(NDIMS, dg.length); i++) this.dimGain[i] = dg[i];
    }
    this.weights = new Float64Array(NDIMS);
    for (let i = 0; i < NDIMS; i++) this.weights[i] = WEIGHTS[i] * this.dimGain[i];
    this.neutral = Float64Array.from(NEUTRAL);
    if (poses.neutral) {
      const neutralIn = Float64Array.from(poses.neutral);
      for (let i = 0; i < Math.min(NDIMS, neutralIn.length); i++) this.neutral[i] = neutralIn[i];
    }

    const rng = poses.ranges || {};
    this.p05 = new Float64Array(NDIMS).fill(-1.0);
    this.p95 = new Float64Array(NDIMS).fill(1.0);
    if (rng.p05) {
      const a = Float64Array.from(rng.p05);
      for (let i = 0; i < Math.min(NDIMS, a.length); i++) this.p05[i] = a[i];
    }
    if (rng.p95) {
      const b = Float64Array.from(rng.p95);
      for (let i = 0; i < Math.min(NDIMS, b.length); i++) this.p95[i] = b[i];
    }
    // `ranges.reach` (index.build_reach): the range the bank can actually *show*, from
    // the coverage bins that hold >= 3 frames, not the p05/p95 of the whole index. On
    // Nanda3_v2 the p05/p95 of 959 frames squashes 127 wide frames into ±6°; the reach
    // of the same bank is -30..+6.5°. Absent => p05/p95.
    this.reachLo = Float64Array.from(this.p05);
    this.reachHi = Float64Array.from(this.p95);
    let hasReach = false;
    const reach = rng.reach;
    if (reach && reach.lo && reach.hi && reach.lo.length && reach.hi.length) {
      const rl = Float64Array.from(reach.lo);
      const rh = Float64Array.from(reach.hi);
      for (let i = 0; i < Math.min(NDIMS, rl.length); i++) this.reachLo[i] = rl[i];
      for (let i = 0; i < Math.min(NDIMS, rh.length); i++) this.reachHi[i] = rh[i];
      hasReach = true;
    }
    this.hasReach = hasReach;
    // a degenerate reach would divide the retarget by zero
    for (let i = 0; i < NDIMS; i++) {
      if (this.reachHi[i] - this.reachLo[i] < 1e-6) {
        this.reachLo[i] -= 0.05;
        this.reachHi[i] += 0.05;
      }
    }
    this.restFrame = Math.trunc(Number(poses.restFrame ?? 0));

    // sequences
    const seqs = poses.seq && poses.seq.length ? poses.seq : [{ name: 'idle', low: 0, high: n - 1 }];
    this.seqOf = new Int32Array(n);
    this.seqKindOf = new Int32Array(n).fill(SEQ_OTHER);
    const fs = poses.frameSeq ? Int32Array.from(poses.frameSeq) : null;
    if (fs && fs.length === n) {
      this.seqOf.set(fs);
      for (let si = 0; si < seqs.length; si++) {
        const kind = seqKind(seqs[si].name);
        for (let i = 0; i < n; i++) if (this.seqOf[i] === si) this.seqKindOf[i] = kind;
      }
    } else {
      for (let si = 0; si < seqs.length; si++) {
        const lo = Math.trunc(seqs[si].low);
        const hi = Math.trunc(seqs[si].high);
        const kind = seqKind(seqs[si].name);
        for (let i = lo; i <= hi; i++) {
          this.seqOf[i] = si;
          this.seqKindOf[i] = kind;
        }
      }
    }
    this.kindIndex = { [SEQ_IDLE]: [], [SEQ_TALK]: [], [SEQ_OTHER]: [] };
    for (let i = 0; i < n; i++) this.kindIndex[this.seqKindOf[i]].push(i);

    // Which frames belong to the avatar the creator authored. `index.sequencesFromRanges`
    // names the author's ranges `idle` / `talk` / `action:<name>` and every contiguous
    // leftover `orphan:<k>`; frames appended by an Ania 2.0 coverage upgrade fall outside
    // all the authored ranges, so they land in the orphans — which is exactly what
    // `frame_pool: "legacy"` excludes.
    this.seqLegacyOf = new Uint8Array(n);
    for (let si = 0; si < seqs.length; si++) {
      if (!seqIsLegacy(seqs[si].name)) continue;
      for (let i = 0; i < n; i++) if (this.seqOf[i] === si) this.seqLegacyOf[i] = 1;
    }
    this.allowed = this.buildPool(n);

    this.cutAfter = new Uint8Array(n);
    const cuts = poses.cuts;
    if (cuts) {
      for (let ci2 = 0; ci2 < cuts.length; ci2++) {
        const ci = Math.trunc(cuts[ci2]);
        if (ci >= 0 && ci < n) this.cutAfter[ci] = 1;
      }
    }

    // graph (CSR); without a graph we build the bare succ/pred chain
    if (graph) {
      this.offsets = Int32Array.from(graph.offsets);
      this.to = Int32Array.from(graph.to);
      this.cost = Float64Array.from(graph.cost);
      if (graph.restFrame !== undefined) this.restFrame = Math.trunc(Number(graph.restFrame));
    } else {
      const offs: number[] = [0];
      const to: number[] = [];
      const cost: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i + 1 < n && this.seqOf[i + 1] === this.seqOf[i] && !this.cutAfter[i]) {
          to.push(i + 1);
          cost.push(1.0);
        }
        if (i - 1 >= 0 && this.seqOf[i - 1] === this.seqOf[i] && !this.cutAfter[i - 1]) {
          to.push(i - 1);
          cost.push(1.0);
        }
        offs.push(to.length);
      }
      this.offsets = Int32Array.from(offs);
      this.to = Int32Array.from(to);
      this.cost = Float64Array.from(cost);
    }
    this.edgeCost = new Map();
    for (let i = 0; i < n; i++) {
      for (let e = this.offsets[i]; e < this.offsets[i + 1]; e++) {
        this.edgeCost.set(i * n + this.to[e], this.cost[e]);
      }
    }

    // blink event index: the eye-closed frames of this bank and their head bins
    const blinkList: number[] = [];
    this.yawBin = new Int32Array(n);
    this.pitchBin = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const closed = Math.max(this.F[i * NDIMS + BLINK_L], this.F[i * NDIMS + BLINK_R]);
      if (closed >= this.opt.blink_frame_threshold) blinkList.push(i);
      this.yawBin[i] = binOf(this.F[i * NDIMS + 0], BLINK_YAW_EDGES);
      this.pitchBin[i] = binOf(this.F[i * NDIMS + 1], BLINK_PITCH_EDGES);
    }
    this.blinkFrames = Int32Array.from(blinkList);

    this.openness = new Float64Array(n).fill(NaN);

    this.oneEuro = oneEuro ?? null;
    this.reset();
  }

  /**
   * Adopt the legacy lip-sync openness map (`AnimationController.buildOpennessMap`) as
   * the primary mouth measure of the ARTICULATE state, so the camera path picks the same
   * frames the audio path would instead of re-deriving "openness" from the descriptor's
   * MAR. Indexed relative to `talkLow`, exactly as the player stores it.
   */
  setOpennessMap(opennessMap: ArrayLike<number> | null | undefined, talkLow: number): void {
    this.openness = new Float64Array(this.N).fill(NaN);
    this.hasOpenness = false;
    if (!opennessMap || !opennessMap.length) return;
    const lo = Math.trunc(talkLow);
    for (let rel = 0; rel < opennessMap.length; rel++) {
      const j = lo + rel;
      if (j >= 0 && j < this.N) {
        const v = Number(opennessMap[rel]);
        if (Number.isFinite(v)) this.openness[j] = v;
      }
    }
    for (let i = 0; i < this.N; i++) {
      if (Number.isFinite(this.openness[i])) {
        this.hasOpenness = true;
        break;
      }
    }
  }

  /** The idle frame nearest the neutral pose — the DECAY-mode hub target. */
  getRestFrame(): number {
    return this.restFrame;
  }

  // ------------------------------------------------------------------ state
  reset(): void {
    this.xHat = Float64Array.from(this.neutral);
    this.maskLive = 0;
    this.lastPoseAt = null;
    this.lastStepAt = null;
    this.talking = false;
    this.envelope = 0;
    this.intensity = 0.6;
    this.recent = [];
    this.runTicks = this.opt.min_run_ticks;
    this.dwellTicks = 0;
    this.lastTeleportAt = -1e12;
    this.idleTicks = 0;
    this.tick = 0;
    this.lastS = null;
    this.lastDen = null;
    this.lastGlobal = [];
    this.denCacheMask = -1;
    this.denCache = null;
    this.emaEBest = 0;
    this.lastTransitionCost = 0;
    this.breathingActive = false;
    this.lastBlinkAt = -1e12;
    this.blinkEvents = 0;
    this.blinkPrev = 0;
    this.blinkHold = 0;
    this.articulating = false;
    this.articulateUntil = -1e12;
    this.micOpenness = null;
    this.mouthHist = [];
    this.silenceSince = null;
    this.mouthPolicyEff = this.opt.mouth_policy === 'mocap' ? 'mocap' : 'audio';
    this.holdPeak = new Float64Array(NDIMS);
    this.holdT = new Float64Array(NDIMS);
    this.holdInit = new Uint8Array(NDIMS);
    this.oneEuro?.reset();
  }

  // ------------------------------------------------------------------ inputs
  pushPose(tMs: number, mask: number, values: ArrayLike<number>, norm: 'raw' | 'cal' = 'raw'): void {
    let x: Float64Array<ArrayBufferLike> = new Float64Array(NDIMS);
    const len = Math.min(values.length, NDIMS);
    for (let i = 0; i < len; i++) x[i] = values[i];
    if (norm === 'cal') {
      const mapped = new Float64Array(NDIMS);
      if (this.opt.use_reach) {
        // Map the user's own p05/p95 (already normalised to [-1, 1] by the calibration)
        // onto what the bank can SHOW, scale the deviation about the mid-point by the
        // level's retarget gain, then clamp to the reach plus the §6-rule-4 overshoot.
        for (let i = 0; i < NDIMS; i++) {
          const loR = this.reachLo[i];
          const hiR = this.reachHi[i];
          const span = hiR - loR;
          const clamped = Math.min(1.2, Math.max(-1.2, x[i]));
          let m = loR + (clamped + 1.0) * 0.5 * span;
          const mid = (loR + hiR) * 0.5;
          m = mid + this.opt.retarget_gain * (m - mid);
          const lo = loR - RETARGET_OVERSHOOT[i] * span;
          const hi = hiR + RETARGET_OVERSHOOT[i] * span;
          mapped[i] = Math.min(Math.max(m, lo), hi);
        }
      } else {
        for (let i = 0; i < NDIMS; i++) {
          const span = this.p95[i] - this.p05[i];
          const clamped = Math.min(1.2, Math.max(-1.2, x[i]));
          let m = this.p05[i] + (clamped + 1.0) * 0.5 * span;
          const lo = this.p05[i] - 0.1 * span;
          const hi = this.p95[i] + 0.1 * span;
          m = Math.min(Math.max(m, lo), hi);
          mapped[i] = m;
        }
      }
      for (let i = 0; i < NDIMS; i++) x[i] = RETARGET[i] ? mapped[i] : x[i];
    }
    // Never let a non-finite value reach the filter or `xHat`. One NaN in the
    // One-Euro state is permanent (`xHat + a*(x - xHat)` stays NaN forever), and
    // one NaN dim makes every candidate cost NaN in `scores()`, so every
    // `Number.isFinite(S[j])` test fails, the cost loop selects nothing, and the
    // avatar freezes on the current frame reporting `S_best = -1`, `E_best = 0`
    // and a climbing `dwell`. A producer that emits garbage must degrade to
    // "that dim reads neutral", never to a freeze. Finite inputs are untouched,
    // so the Python parity fixtures are unaffected.
    for (let i = 0; i < NDIMS; i++) if (!Number.isFinite(x[i])) x[i] = this.neutral[i];
    if (this.oneEuro) x = this.oneEuro.filterMasked(tMs, x, mask);
    for (let i = 0; i < NDIMS; i++) if (!Number.isFinite(x[i])) x[i] = this.neutral[i];
    const act = groupVector(mask);
    if (this.opt.hold_ms > 0) x = this.applyHold(tMs, x, act);
    for (let i = 0; i < NDIMS; i++) if (act[i] > 0.5) this.xHat[i] = x[i];
    this.maskLive = mask;
    this.lastPoseAt = tMs;
  }

  setAudio(talking: boolean, envelope: number, intensity = 0.6): void {
    this.talking = !!talking;
    this.envelope = Math.max(0.0, Math.min(1.0, envelope));
    this.intensity = Math.max(0.0, Math.min(1.0, intensity));
  }

  setMouthPolicy(policy: string): void {
    this.opt.mouth_policy = policy === 'mocap' || policy === 'auto' ? policy : 'audio';
  }

  hasFreshPose(nowMs: number): boolean {
    return this.lastPoseAt !== null && nowMs - this.lastPoseAt <= this.opt.idle_after_ms;
  }

  // ---- §4.5 expression hold ------------------------------------------------
  private holdDims(): readonly number[] {
    return this.mouthPolicyEff === 'mocap' ? [...HOLD_DIMS, HOLD_DIM_MOUTH_OPEN] : HOLD_DIMS;
  }

  /**
   * Hold a one-sided expression at its peak for `hold_ms`, then release it linearly
   * over `hold_release_ms`. Blinks, head, body and hands are exempt — they must be
   * fast. Runs on the filtered target, before the matcher, so every runtime gets the
   * behaviour from one place.
   */
  private applyHold(tMs: number, x: Float64Array, act: Float64Array | ArrayLike<number>): Float64Array {
    const out = Float64Array.from(x);
    const hold = this.opt.hold_ms;
    const rel = Math.max(1e-6, this.opt.hold_release_ms);
    for (const d of this.holdDims()) {
      if (!(act[d] > 0.5)) continue;
      const v = x[d];
      if (!this.holdInit[d] || v >= this.holdPeak[d]) {
        this.holdPeak[d] = v;
        this.holdT[d] = tMs;
        this.holdInit[d] = 1;
        continue;
      }
      const dt = tMs - this.holdT[d];
      if (dt <= hold) {
        out[d] = this.holdPeak[d];
      } else if (dt <= hold + rel) {
        const a = (dt - hold) / rel;
        out[d] = this.holdPeak[d] * (1.0 - a) + v * a;
      } else {
        this.holdPeak[d] = v;
        this.holdT[d] = tMs;
      }
    }
    return out;
  }

  // ---- blink priority event --------------------------------------------------
  /**
   * The eye-closed frame to jump to: prefer one in the same head bin, else the cheapest
   * transition from the graph, then by pose-cost, then by index.
   */
  private pickBlinkFrame(i: number, S: Float64Array): number | null {
    if (this.blinkFrames.length === 0) return null;
    const allowedBlinks: number[] = [];
    for (const t of this.blinkFrames) if (this.allowed[t]) allowedBlinks.push(t);
    if (allowedBlinks.length === 0) return null;
    const same: number[] = [];
    for (const t of allowedBlinks) if (this.yawBin[t] === this.yawBin[i] && this.pitchBin[t] === this.pitchBin[i]) same.push(t);
    const useGraph = same.length === 0;
    const pool: ArrayLike<number> = useGraph ? allowedBlinks : same;
    let best: number | null = null;
    let bestKey: number[] | null = null;
    for (let k = 0; k < pool.length; k++) {
      const j = pool[k];
      const s = Number.isFinite(S[j]) ? S[j] : 1e18;
      const key = useGraph
        ? [Math.round(this.transition(i, j)[0] * 1e9) / 1e9, Math.round(s * 1e9) / 1e9, j]
        : [Math.round(s * 1e9) / 1e9, j];
      if (bestKey === null || lexLess(key, bestKey)) {
        bestKey = key;
        best = j;
      }
    }
    return best;
  }

  /**
   * Frame to force this tick because of a blink, or `null`. Updates the edge state on
   * every tick so the detector cannot latch.
   */
  private blinkStep(nowMs: number, mode: string, i: number, S: Float64Array): number | null {
    if (!this.opt.blink_event) return null;
    const b = Math.max(this.xHat[BLINK_L], this.xHat[BLINK_R]);
    const rising = b >= this.opt.blink_threshold && this.blinkPrev < this.opt.blink_threshold;
    this.blinkPrev = b;
    if (this.blinkHold > 0) {
      this.blinkHold -= 1;
      return i; // keep the eyes closed
    }
    if (!rising || mode !== MODE_LIVE) return null;
    if (nowMs - this.lastBlinkAt < this.opt.blink_refractory_ms) return null;
    const j = this.pickBlinkFrame(i, S);
    if (j === null) return null;
    this.lastBlinkAt = nowMs;
    this.blinkEvents += 1;
    this.blinkHold = Math.max(0, Math.trunc(this.opt.blink_hold_ticks) - 1);
    return j;
  }

  // ---- ARTICULATE ------------------------------------------------------------
  /**
   * 0..1 speech envelope of the USER's microphone (`mouth_blend` mic/hybrid).
   *
   * The camera keeps smile / width / pucker; the mic only owns how OPEN the mouth is,
   * which is the one channel a webcam at 12 Hz cannot resolve fast enough to look like
   * speech. `null` = no mic.
   */
  setMicOpenness(openness: number | null | undefined, atMs?: number): void {
    if (typeof atMs === 'number' && Number.isFinite(atMs)) this.micPushedAt = atMs;
    if (openness === null || openness === undefined) {
      this.micOpenness = null;
      return;
    }
    const v = Number(openness);
    if (!Number.isFinite(v)) {
      this.micOpenness = Number.isNaN(v) ? 0.0 : null;
      return;
    }
    this.micOpenness = Math.max(0.0, Math.min(1.0, v));
  }

  /**
   * The mouth-open target the ARTICULATE search aims at: by default the louder of the mic
   * envelope and the attenuated camera opening, so a user who is speaking drives the
   * mouth even when the webcam is too slow to catch the articulation.
   */
  mouthOpenTarget(): number {
    const cam = Math.max(0.0, Math.min(1.0, Math.max(this.xHat[MOUTH_OPEN], this.xHat[JAW_OPEN])));
    const mic = this.micOpenness;
    const blend = this.opt.mouth_blend;
    if (mic === null || blend === 'camera') return cam;
    if (blend === 'mic') return mic;
    return Math.max(0.0, Math.min(1.0, Math.max(mic, cam * this.opt.mouth_camera_weight)));
  }

  /**
   * Speech-like activity on the mouth target keeps the sub-state armed for
   * `articulate_hold_ms` after the last sign of it.
   */
  private articulateActive(nowMs: number, policy: string, mode: string): boolean {
    if (!this.opt.articulate || policy !== 'mocap' || mode !== MODE_LIVE) {
      this.mouthHist.length = 0;
      this.articulating = false;
      return false;
    }
    const v = this.mouthOpenTarget();
    const prev = this.mouthHist.length ? this.mouthHist[this.mouthHist.length - 1][1] : v;
    this.mouthHist.push([nowMs, v]);
    if (this.mouthHist.length > 64) this.mouthHist.shift();
    while (this.mouthHist.length && nowMs - this.mouthHist[0][0] > this.opt.articulate_window_ms) this.mouthHist.shift();
    let variance = 0;
    if (this.mouthHist.length >= 3) {
      let mean = 0;
      for (const [, x] of this.mouthHist) mean += x;
      mean /= this.mouthHist.length;
      for (const [, x] of this.mouthHist) variance += (x - mean) * (x - mean);
      variance /= this.mouthHist.length;
    }
    if (variance >= this.opt.articulate_var_threshold || v - prev > this.opt.articulate_rise) {
      this.articulateUntil = nowMs + this.opt.articulate_hold_ms;
    }
    this.articulating = nowMs < this.articulateUntil;
    return this.articulating;
  }

  /**
   * Pick the frame whose MOUTH matches best inside the current head bin.
   *
   * Candidates: every frame whose yaw/pitch bins are within `articulate_bin_slack` of the
   * current frame's, plus the current frame's graph edges (so the search can still follow
   * a cheap transition out of a thin bin). Cost: the normal weighted SSD with MOUTH ×4
   * and HEAD ×0.5 — or, when the bank carries the legacy openness map, the same
   * `|openness - target|` the audio path minimises, which is what makes the camera and
   * the audio choose the same mouths.
   */
  private articulatePick(i: number, x: Float64Array, vLive: Float64Array): number | null {
    const slack = Math.trunc(this.opt.articulate_bin_slack);
    const cands = new Set<number>();
    for (let t = 0; t < this.N; t++) {
      if (
        this.allowed[t] &&
        Math.abs(this.yawBin[t] - this.yawBin[i]) <= slack &&
        Math.abs(this.pitchBin[t] - this.pitchBin[i]) <= slack
      ) {
        cands.add(t);
      }
    }
    // The cursor itself is always rankable, in or out of the pool: the legacy cycler may
    // have parked it anywhere, and a search with nowhere to stand freezes the avatar.
    cands.add(i);
    for (const e of this.edgesOf(i)) if (this.allowed[e]) cands.add(e);
    const idx = Array.from(cands).sort((a, b) => a - b);
    if (!idx.length) return null;
    const w = Float64Array.from(this.weights);
    for (const d of ARTICULATE_MOUTH_DIMS) w[d] *= this.opt.articulate_mouth_gain;
    for (const d of ARTICULATE_HEAD_DIMS) w[d] *= this.opt.articulate_head_gain;
    const wv = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) wv[d] = w[d] * vLive[d];
    const target = this.mouthOpenTarget();
    let mouthW = 0;
    if (this.hasOpenness) {
      for (const d of ARTICULATE_MOUTH_DIMS) mouthW += WEIGHTS[d];
      mouthW *= this.opt.articulate_mouth_gain;
    }
    let best: number | null = null;
    let bestKey: number[] | null = null;
    for (const j of idx) {
      const row = j * NDIMS;
      let s = 0;
      for (let d = 0; d < NDIMS; d++) {
        if (this.Vmat[row + d] === 0 || wv[d] === 0) continue;
        const diff = this.F[row + d] - x[d];
        s += diff * diff * this.Vmat[row + d] * wv[d];
      }
      if (this.hasOpenness && Number.isFinite(this.openness[j])) {
        // openness map available: it, not the descriptor MAR, is the mouth measure
        let mouthTerm = 0;
        for (const d of ARTICULATE_MOUTH_DIMS) {
          const diff = this.F[row + d] - x[d];
          mouthTerm += diff * diff * this.Vmat[row + d] * wv[d];
        }
        const dOp = this.openness[j] - target;
        s = s - mouthTerm + mouthW * dOp * dOp;
      }
      if (!Number.isFinite(s)) continue;
      const cost = s + (j !== i ? this.opt.articulate_step_penalty : 0);
      const key = [Math.round(cost * 1e9) / 1e9, j];
      if (bestKey === null || lexLess(key, bestKey)) {
        bestKey = key;
        best = j;
      }
    }
    return best;
  }

  // ---- §4.3 mouth handover -------------------------------------------------
  /**
   * `audio` while the voice owns the mouth, `mocap` when the camera does.
   *
   * `mouth_policy = "auto"` follows the audio with hysteresis: talking → audio
   * immediately; silence → wait `mouth_handover_ms` and only then hand the mouth to
   * the camera, and any talking inside that window cancels the pending switch.
   * `talking_forces_audio` applies §6 rule 1 to the static `mocap` policy too (level
   * `mirror`): no camera mouth while audio is playing.
   */
  private effectiveMouthPolicy(nowMs: number): 'audio' | 'mocap' {
    const p = this.opt.mouth_policy;
    if (this.talking) {
      this.silenceSince = null;
      if (p === 'auto' || (p === 'mocap' && this.opt.talking_forces_audio)) return 'audio';
      return p === 'mocap' ? 'mocap' : 'audio';
    }
    if (p !== 'auto') return p === 'mocap' ? 'mocap' : 'audio';
    if (!this.opt.mouth_camera_allowed) {
      this.silenceSince = null;
      return 'audio';
    }
    if (this.silenceSince === null) this.silenceSince = nowMs;
    if (nowMs - this.silenceSince >= this.opt.mouth_handover_ms) return 'mocap';
    return 'audio';
  }

  /**
   * What is driving the mouth right now, in the words the HUD uses: `"audio"` (the
   * avatar's own voice / lip-sync) or `"camera"` (the user's mouth). Follows the
   * effective policy, so it flips back to `audio` the instant the avatar starts
   * speaking at every level, including `mirror` (§6 rule 1).
   */
  get mouthSource(): 'audio' | 'camera' {
    return this.mouthPolicyEff === 'mocap' ? 'camera' : 'audio';
  }

  // ------------------------------------------------------------------ helpers
  private modeAt(now: number): [string, number] {
    if (this.lastPoseAt === null || this.maskLive === 0) return [MODE_IDLE, Infinity];
    const age = now - this.lastPoseAt;
    if (age <= this.opt.stale_ms) return [MODE_LIVE, age];
    if (age <= this.opt.idle_after_ms) return [MODE_DECAY, age];
    return [MODE_IDLE, age];
  }

  private isNatural(i: number, j: number): boolean {
    if (j === i) return true;
    if (j === i + 1) return j < this.N && this.seqOf[j] === this.seqOf[i] && !this.cutAfter[i];
    if (j === i - 1 && j >= 0) return this.seqOf[j] === this.seqOf[i] && !this.cutAfter[j];
    return false;
  }

  private edgesOf(i: number): Int32Array {
    return this.to.subarray(this.offsets[i], this.offsets[i + 1]);
  }

  private transition(i: number, j: number): [number, boolean] {
    if (this.isNatural(i, j)) return [0.0, true];
    const c = this.edgeCost.get(i * this.N + j);
    if (c !== undefined) return [c, true];
    return [this.opt.c_jump, false];
  }

  private scores(x: Float64Array, wv: Float64Array, mask: number): [Float64Array, Float64Array] {
    const n = this.N;
    const S = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const row = i * NDIMS;
      let s = 0;
      for (let d = 0; d < NDIMS; d++) {
        // Skip dims that contribute nothing — a masked-off group, a dim the bank
        // marked invalid, or a zero weight (every reserved dim, and the mouth
        // dims the audio policy zeroes). Their term is exactly `0`, so dropping
        // it is bit-identical for finite inputs, but it also stops `0 * NaN` from
        // poisoning the whole row when a value slipped through non-finite.
        if (this.Vmat[row + d] === 0 || wv[d] === 0) continue;
        const diff = this.F[row + d] - x[d];
        s += diff * diff * this.Vmat[row + d] * wv[d];
      }
      S[i] = Number.isFinite(s) ? s : Infinity;
    }
    let den: Float64Array;
    if (this.denCacheMask === mask && this.denCache) {
      den = this.denCache;
    } else {
      den = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const row = i * NDIMS;
        let s = 0;
        for (let d = 0; d < NDIMS; d++) s += this.Vmat[row + d] * wv[d];
        den[i] = s;
      }
      this.denCacheMask = mask;
      this.denCache = den;
    }
    for (let i = 0; i < n; i++) if (!(den[i] >= 1.0)) S[i] = Infinity;
    // One place decides which frames exist for this level: a frame outside the pool is
    // unreachable by every route at once — global search, graph edge, teleport, blink,
    // articulate and the preferred-kind shortlist all rank by S.
    for (let i = 0; i < n; i++) if (!this.allowed[i]) S[i] = Infinity;
    return [S, den];
  }

  // ------------------------------------------------------------------ step
  step(nowMs: number, currentFrame: number, isCached?: (j: number) => boolean): StepResult {
    const opt = this.opt;
    const n = this.N;
    const i = Math.max(0, Math.min(n - 1, Math.trunc(currentFrame)));
    const dtStep = this.lastStepAt === null ? 0 : Math.max(0, nowMs - this.lastStepAt);
    this.lastStepAt = nowMs;
    this.tick += 1;
    const [mode, age] = this.modeAt(nowMs);

    // ---- target assembly
    if (mode === MODE_DECAY && dtStep > 0) {
      const k = 1.0 - Math.exp(-dtStep / opt.decay_tau_ms);
      for (let d = 0; d < NDIMS; d++) this.xHat[d] += (this.neutral[d] - this.xHat[d]) * k;
    }
    let x = Float64Array.from(this.xHat);
    let mask = this.maskLive;
    if (mode === MODE_IDLE) {
      x = Float64Array.from(this.neutral);
      mask = 0xff;
    }
    const policy = this.effectiveMouthPolicy(nowMs);
    this.mouthPolicyEff = policy;
    const w = Float64Array.from(this.weights);
    if (policy === 'audio') {
      const env = this.envelope;
      let boosted = env < 0.06 ? 0.0 : Math.min(1.0, env * (0.4 + 1.6 * this.intensity));
      if (!this.talking) boosted = 0.0;
      x[DIM_INDEX.mouthOpen] = boosted;
      x[DIM_INDEX.jawOpen] = boosted;
      for (const name of ['mouthSmile', 'mouthFrown', 'mouthPucker', 'mouthWidth']) w[DIM_INDEX[name]] = 0.0;
      mask |= 1 << G_MOUTH;
    } else if (this.micOpenness !== null && (opt.mouth_blend === 'mic' || opt.mouth_blend === 'hybrid')) {
      // The user owns the mouth and a microphone is running: how OPEN it is comes from
      // the mic (50 Hz) instead of the webcam (11-13 Hz in the live player), by the same
      // route the avatar's own audio takes. The camera keeps smile, width, pucker and
      // everything else.
      const tgt = this.mouthOpenTarget();
      x[MOUTH_OPEN] = tgt;
      x[JAW_OPEN] = tgt;
      mask |= 1 << G_MOUTH;
    }
    // `vLive` already carries `dimValid`, exactly as the Python reference does, so the
    // ARTICULATE search below can reuse it without re-applying the validity mask.
    const gv = groupVector(mask);
    const vLive = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) vLive[d] = gv[d] * this.dimValid[d];
    const wv = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) wv[d] = w[d] * vLive[d];

    // ---- global scores (optionally every k-th tick)
    const doGlobal = opt.global_search_every <= 1 || this.tick % opt.global_search_every === 1 || this.lastS === null;
    if (doGlobal) {
      const [S0, den0] = this.scores(x, wv, mask);
      this.lastS = S0;
      this.lastDen = den0;
      const m = Math.min(opt.global_m, n);
      // smallest M by (S, index): a total order, so every port picks the same set
      const order = Array.from({ length: n }, (_, idx) => idx).sort(byScoreThenIndex(S0));
      this.lastGlobal = order.slice(0, m);
    }
    let S = this.lastS as Float64Array;
    const den = this.lastDen as Float64Array;
    const globalC = this.lastGlobal;
    // The cursor can sit outside the pool (the legacy cycler parked it there, or the user
    // just switched away from `mirror`). Keep it rankable — otherwise no candidate is
    // finite, the cost loop selects nothing and the avatar freezes.
    if (!Number.isFinite(S[i])) {
      S = Float64Array.from(S);
      const row = i * NDIMS;
      let acc = 0;
      for (let d = 0; d < NDIMS; d++) {
        if (this.Vmat[row + d] === 0 || wv[d] === 0) continue;
        const diff = this.F[row + d] - x[d];
        acc += diff * diff * this.Vmat[row + d] * wv[d];
      }
      S[i] = Number.isFinite(acc) ? acc : Infinity;
    }

    // ---- audio prior per sequence kind (also part of the teleport gate)
    const wA = policy === 'audio' ? opt.w_a_audio : opt.w_a_mocap;
    const audioPrior = (j: number): number => {
      const kind = this.seqKindOf[j];
      if (mode === MODE_IDLE) return kind === SEQ_IDLE ? 0.0 : 1.0;
      if (policy === 'mocap') {
        if (this.talking) return kind === SEQ_TALK ? 0.0 : kind === SEQ_IDLE ? 0.5 : 0.25;
        return kind === SEQ_IDLE ? 0.0 : kind === SEQ_TALK ? 0.5 : 0.25;
      }
      if (this.talking) return kind === SEQ_TALK ? 0.0 : 1.0;
      return kind === SEQ_IDLE ? 0.0 : kind === SEQ_TALK ? 0.5 : 0.25;
    };
    const preferredKind = mode === MODE_IDLE || !this.talking ? SEQ_IDLE : SEQ_TALK;

    // ---- candidates
    const cands = new Set<number>([i]);
    if (i + 1 < n) cands.add(i + 1);
    if (i - 1 >= 0) cands.add(i - 1);
    for (const j of this.edgesOf(i)) cands.add(j);
    if (opt.allow_skip && i + 2 < n && this.isNatural(i, i + 1) && this.isNatural(i + 1, i + 2)) {
      if (S[i + 2] < S[i + 1] - opt.skip_gain) cands.add(i + 2);
    }
    for (const j of globalC) cands.add(j);
    // best 2 frames of the audio-preferred kind so a mode switch has somewhere to go
    const pk = this.kindIndex[preferredKind];
    if (pk && pk.length && this.seqKindOf[i] !== preferredKind) {
      const sorted = pk.slice().sort(byScoreThenIndex(S));
      const k2 = Math.min(2, pk.length);
      for (let t = 0; t < k2; t++) cands.add(sorted[t]);
    }

    // ---- teleport gate
    let bestEdgeScore = Infinity;
    for (const j of cands) {
      if (Number.isFinite(S[j]) && this.transition(i, j)[1]) {
        const s = S[j] + wA * audioPrior(j);
        if (s < bestEdgeScore) bestEdgeScore = s;
      }
    }
    const teleportAllowed =
      opt.allow_teleport && mode === MODE_LIVE && nowMs - this.lastTeleportAt >= opt.teleport_cooldown_ms;

    // ---- breathing (§4.4): a still user keeps drifting along the run instead of
    // freezing. Deterministic — a fixed cost bonus on the natural successor, never an
    // RNG, or the ports diverge and the parity fixture breaks.
    const breathing = !!opt.breathing && mode === MODE_LIVE && this.dwellTicks >= opt.breathing_dwell_ticks;
    const breatheJ = breathing && i + 1 < n && this.isNatural(i, i + 1) && this.allowed[i + 1] ? i + 1 : null;
    this.breathingActive = breathing;

    // ---- cost loop (deterministic order)
    let bestKey: [number, number, number] | null = null;
    let bestJ = i;
    let bestIsEdge = true;
    const recentSet = new Set(this.recent);
    const holdPen = Math.min(opt.hold_penalty_max, opt.hold_penalty_per_tick * Math.max(0, this.dwellTicks - opt.hold_free_ticks));
    const sortedCands = Array.from(cands).sort((a, b) => a - b);
    for (const j of sortedCands) {
      if (!Number.isFinite(S[j])) continue;
      let [T, isEdge] = this.transition(i, j);
      const A = audioPrior(j);
      if (!isEdge) {
        if (!teleportAllowed || bestEdgeScore - (S[j] + wA * A) <= opt.teleport_min_gain) continue;
      }
      if (j === i + 2 && this.isNatural(i, i + 1)) T = 0.5;
      let cost = S[j] + opt.w_t * T + wA * A;
      if (j !== i) cost += opt.step_penalty;
      else cost += holdPen;
      const natural = this.isNatural(i, j);
      if (!natural) {
        cost += 0.01;
        if (recentSet.has(j)) cost += 0.03;
        if (this.runTicks < opt.min_run_ticks) cost += 0.05;
      }
      if (isCached && j !== i && !isCached(j)) cost += opt.cache_penalty;
      if (breatheJ !== null && j === breatheJ) cost -= opt.breathing_bonus;
      // lookahead: best successor of j (natural step or edge)
      let la = j + 1 < n && this.isNatural(j, j + 1) ? S[j + 1] : Infinity;
      for (const k of this.edgesOf(j)) if (S[k] < la) la = S[k];
      cost += opt.lookahead_w * (Number.isFinite(la) ? la : S[j]);
      const tie = j === i ? 0 : j === i + 1 ? 1 : j === i - 1 ? 2 : 3;
      const key: [number, number, number] = [Math.round(cost * 1e9) / 1e9, tie, j];
      if (bestKey === null || keyLess(key, bestKey)) {
        bestKey = key;
        bestJ = j;
        bestIsEdge = isEdge;
      }
    }

    // Last-resort liveness: if the cost loop rejected every candidate (all
    // scores non-finite — an unusable bank, or a mask/`dimValid` combination
    // whose total weight never reaches the `den >= 1` floor) the avatar would
    // hold frame `i` forever. Falling through to the natural successor keeps it
    // animating on the bank's own timeline instead. Unreachable whenever any
    // candidate scored, so the parity fixtures never take this branch.
    if (bestKey === null) {
      bestJ = this.isNatural(i, i + 1) ? i + 1 : this.restFrame;
      bestIsEdge = true;
    }

    // ---- ARTICULATE: while the user is speaking the mouth is the objective, inside the
    // head bin the head already chose. No min_run, no teleport gate, no lookahead.
    const articulating = this.articulateActive(nowMs, policy, mode);
    if (articulating) {
      const aJ = this.articulatePick(i, x, vLive);
      if (aJ !== null) {
        bestJ = aJ;
        bestIsEdge = true;
      }
    }

    // ---- blink priority event: overrides the cost loop (and ARTICULATE — a blink is
    // shorter than a syllable), bypasses min_run and the teleport gate, and is never a
    // "teleport" for the crossfade (a 2-tick blink that dissolves in and out is a smear,
    // not a blink).
    const blinkJ = this.blinkStep(nowMs, mode, i, S);
    const blink = blinkJ !== null;
    if (blink) {
      bestJ = blinkJ as number;
      bestIsEdge = true;
    }

    // ---- state update
    const teleport = !bestIsEdge;
    // what the renderer needs for the crossfade (§4.2): the visual cost of the
    // transition actually taken. 0 for a natural step, the graph cost for an edge,
    // c_jump (8) for a teleport.
    // A mouth change inside the head bin is not a jump to be dissolved (the frames look
    // alike by construction), so ARTICULATE reports 0 like the blink does.
    const transitionCost = blink || articulating ? 0.0 : bestJ !== i ? this.transition(i, bestJ)[0] : 0.0;
    this.lastTransitionCost = transitionCost;
    if (teleport) this.lastTeleportAt = nowMs;
    if (bestJ === i) {
      this.dwellTicks += 1;
    } else {
      this.dwellTicks = 0;
      this.recent.push(i);
      if (this.recent.length > opt.recent_len) this.recent.shift();
      if (this.isNatural(i, bestJ)) this.runTicks += 1;
      else this.runTicks = 0;
    }

    // ---- idle handoff
    let handoff = false;
    if (mode === MODE_IDLE) {
      if (this.seqKindOf[bestJ] === SEQ_IDLE) this.idleTicks += 1;
      else this.idleTicks = 0;
      handoff = this.idleTicks >= opt.idle_handoff_ticks;
    } else {
      this.idleTicks = 0;
    }

    // ---- gap detection (EMA of best RMS error)
    const eBest = Number.isFinite(S[bestJ]) && den[bestJ] > 0 ? Math.sqrt(S[bestJ] / den[bestJ]) : 0.0;
    const a = 1.0 - Math.exp(-Math.max(dtStep, 1.0) / opt.gap_ema_tau_ms);
    this.emaEBest += (eBest - this.emaEBest) * a;

    // ---- preload hint (graph locality)
    const pre: number[] = [];
    for (const j of [bestJ + 1, bestJ - 1]) if (j >= 0 && j < n) pre.push(j);
    for (const j of this.edgesOf(bestJ)) if (!pre.includes(j)) pre.push(j);
    const globalSorted = globalC.slice().sort(byScoreThenIndex(S));
    for (const j of globalSorted.slice(0, 4)) if (!pre.includes(j)) pre.push(j);
    const preFinal = pre.slice(0, 16);

    return {
      frame: bestJ,
      mode,
      preload: preFinal,
      handoff,
      teleport,
      transition_cost: transitionCost,
      breathing,
      blink,
      articulating,
      debug: {
        E_best: eBest,
        S_best: Number.isFinite(S[bestJ]) ? S[bestJ] : -1.0,
        age_ms: Number.isFinite(age) ? age : -1.0,
        candidates: cands.size,
        ema_E: this.emaEBest,
        run_ticks: this.runTicks,
        dwell: this.dwellTicks,
        transition_cost: transitionCost,
        tick: this.tick,
        mouth_policy: policy === 'mocap' ? 1.0 : 0.0,
      },
    };
  }

  // ------------------------------------------------------------------ diagnostics
  /** One bank frame's own descriptor row (the affine head-region input). */
  frameDescriptor(frame: number): Float64Array {
    const f = Math.max(0, Math.min(this.N - 1, Math.trunc(frame)));
    return this.F.slice(f * NDIMS, f * NDIMS + NDIMS);
  }

  /** The live (filtered, retargeted) descriptor target. */
  getTarget(): Float64Array {
    return Float64Array.from(this.xHat);
  }

  /** The live group mask of the last pushed pose. */
  getLiveMask(): number {
    return this.maskLive;
  }

  /** The bank's neutral pose at one dim (the DECAY target). */
  neutralAt(dim: number): number {
    return this.neutral[dim];
  }

  /** The bank's p05/p95 at one dim (the legacy, non-reach retarget range). */
  p05At(dim: number): number {
    return this.p05[dim];
  }

  p95At(dim: number): number {
    return this.p95[dim];
  }

  /** Swap (or drop, with `null`) the One-Euro filter — for tests that isolate the hold. */
  setOneEuro(filter: OneEuroVector | null): void {
    this.oneEuro = filter;
  }

  /** Live target minus the chosen frame's descriptor (for the affine warp). */
  residual(frame: number): Float64Array {
    const f = Math.trunc(frame);
    const out = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) out[d] = this.xHat[d] - this.F[f * NDIMS + d];
    return out;
  }

  // ---- candidate pool ---------------------------------------------------------
  /**
   * Boolean per frame: may the matcher show it? (`MatcherOptions.frame_pool`)
   *
   * `all` (the legacy-parity default) allows everything. `legacy` allows only the
   * sequences the creator authored and drops every explicitly excluded range (the
   * manifest's `video.ania2.coverage` block, handed in by the host). A policy that would
   * empty the bank is ignored — a frozen avatar is worse than a wrong frame.
   */
  private buildPool(n: number): Uint8Array {
    const allowed = new Uint8Array(n).fill(1);
    if (String(this.opt.frame_pool ?? 'all') === 'legacy') {
      for (let i = 0; i < n; i++) if (!this.seqLegacyOf[i]) allowed[i] = 0;
    }
    const ranges = this.opt.excluded_ranges;
    if (ranges) {
      for (let t = 0; t < ranges.length; t++) {
        const r = ranges[t];
        if (!r || r.length < 2) continue;
        let lo = Math.trunc(Number(r[0]));
        let hi = Math.trunc(Number(r[1]));
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
        if (hi < lo) {
          const t2 = lo;
          lo = hi;
          hi = t2;
        }
        for (let i = Math.max(0, lo); i <= Math.min(n - 1, hi); i++) allowed[i] = 0;
      }
    }
    for (let i = 0; i < n; i++) if (allowed[i]) return allowed;
    return new Uint8Array(n).fill(1);
  }

  /** How many frames the current pool leaves reachable (HUD / stats). */
  get poolSize(): number {
    let c = 0;
    for (let i = 0; i < this.N; i++) if (this.allowed[i]) c += 1;
    return c;
  }

  /**
   * Visual cost of the step i -> j: 0 for a natural step, the graph's edge cost for a
   * cheap transition, `c_jump` for a cut nothing sanctions. Public because the lab
   * scores whole runs with it (`transitionCostMean`), including runs this matcher did
   * not choose — the legacy player's own playback, for instance.
   */
  transitionCost(i: number, j: number): number {
    const n = this.N;
    const a = Math.max(0, Math.min(n - 1, Math.trunc(i)));
    const b = Math.max(0, Math.min(n - 1, Math.trunc(j)));
    return this.transition(a, b)[0];
  }

  // ---- legacy engine API --------------------------------------------------------
  // `presence` (Sutil) does not call `step()`: the player's own cycler keeps the frame
  // and the three helpers below are the only places the camera touches it.

  /**
   * True exactly once per blink of the USER, refractory-gated. Reads the filtered
   * target, so it costs nothing extra and cannot latch (the edge state is updated on
   * every call, whether or not the event fires).
   */
  blinkEdge(nowMs: number): boolean {
    const b = Math.max(this.xHat[BLINK_L], this.xHat[BLINK_R]);
    const rising = b >= this.opt.blink_threshold && this.blinkPrev < this.opt.blink_threshold;
    this.blinkPrev = b;
    if (!rising) return false;
    if (nowMs - this.lastBlinkAt < this.opt.blink_refractory_ms) return false;
    this.lastBlinkAt = nowMs;
    this.blinkEvents += 1;
    return true;
  }

  /**
   * The eye-closed frame to detour to: inside the SAME sequence as the cursor and no
   * further than `maxDelta` frames away, nearest first (ties by index).
   *
   * Both constraints exist so the detour is invisible: neighbouring frames of one
   * sequence differ by a blink and little else, so the cut in and the cut back read as
   * the blink itself rather than as a jump.
   */
  blinkFrameNear(i: number, maxDelta = 30): number | null {
    const pool = this.blinkFrames;
    if (pool.length === 0) return null;
    const c = Math.max(0, Math.min(this.N - 1, Math.trunc(i)));
    const md = Math.trunc(maxDelta);
    let best: number | null = null;
    let bestD = Infinity;
    for (let t = 0; t < pool.length; t++) {
      const j = pool[t];
      if (this.seqOf[j] !== this.seqOf[c]) continue;
      const d = Math.abs(j - c);
      if (d > md) continue;
      if (!this.allowed[j]) continue;
      if (d < bestD || (d === bestD && best !== null && j < best)) {
        bestD = d;
        best = j;
      }
    }
    return best;
  }

  /**
   * Of the cycler's own start positions, the one whose smile and head yaw sit closest to
   * the user right now. Deterministic (ties by index), pool-aware, and never invents a
   * frame: it only reorders a choice the legacy engine was about to make at random,
   * which is the one moment a cut is already happening.
   */
  startPointScore(candidates: ArrayLike<number> | null | undefined): number | null {
    if (!candidates || candidates.length === 0) return null;
    const x = this.xHat;
    let best: number | null = null;
    let bestD = Infinity;
    for (let t = 0; t < candidates.length; t++) {
      const j = Math.trunc(Number(candidates[t]));
      if (!(j >= 0 && j < this.N)) continue;
      if (!this.allowed[j]) continue;
      let d = 0;
      for (const [dim, w] of START_POINT_DIMS) {
        const diff = this.F[j * NDIMS + dim] - x[dim];
        d += w * diff * diff;
      }
      d = Math.round(d * 1e9) / 1e9;
      if (d < bestD || (d === bestD && best !== null && j < best)) {
        bestD = d;
        best = j;
      }
    }
    return best;
  }

  /**
   * 0..1 openness of the USER's microphone for the legacy talk path, or `null`.
   *
   * `null` means the mic has nothing to say — none was ever pushed, the caller pushed
   * `null`, or the last sample is older than `staleMs`. A stale sample must not keep
   * driving the mouth: a capture that dies mid-word would leave the avatar frozen with
   * its mouth open.
   */
  micOpennessAt_(nowMs: number, staleMs = 400.0): number | null {
    if (this.micOpenness === null) return null;
    if (this.micPushedAt !== null && nowMs - this.micPushedAt > staleMs) return null;
    return this.micOpenness;
  }

  /** RMS pose error of x vs one frame under a live mask (E units). */
  poseError(x: ArrayLike<number>, mask: number, frame: number): number {
    const vLive = groupVector(mask);
    const wv = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) wv[d] = this.weights[d] * vLive[d] * this.dimValid[d];
    const f = Math.trunc(frame);
    let num = 0;
    let den = 0;
    for (let d = 0; d < NDIMS; d++) {
      const diff = this.F[f * NDIMS + d] - (x[d] ?? 0);
      num += diff * diff * this.Vmat[f * NDIMS + d] * wv[d];
      den += this.Vmat[f * NDIMS + d] * wv[d];
    }
    return den >= 1.0 ? Math.sqrt(num / den) : Infinity;
  }
}
