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
  mouth_policy: 'audio' | 'mocap';
  stale_ms: number;
  idle_after_ms: number;
  decay_tau_ms: number;
  teleport_cooldown_ms: number;
  teleport_min_gain: number;
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
}

export const DEFAULT_MATCHER_OPTIONS: MatcherOptions = {
  w_t: 0.01,
  c_jump: 8.0,
  w_a_mocap: 0.1,
  w_a_audio: 0.3,
  mouth_policy: 'audio',
  stale_ms: 400.0,
  idle_after_ms: 3000.0,
  decay_tau_ms: 1500.0,
  teleport_cooldown_ms: 500.0,
  teleport_min_gain: 0.15,
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
  ranges?: { p05?: ArrayLike<number>; p95?: ArrayLike<number> };
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

function seqKind(name: string): number {
  const n = (name || '').toLowerCase();
  if (n.startsWith('idle')) return SEQ_IDLE;
  if (n.startsWith('talk')) return SEQ_TALK;
  return SEQ_OTHER;
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
  private restFrame: number;

  private readonly seqOf: Int32Array;
  private readonly seqKindOf: Int32Array;
  private readonly kindIndex: Record<number, number[]>;
  private readonly cutAfter: Uint8Array;

  private readonly offsets: Int32Array;
  private readonly to: Int32Array;
  private readonly cost: Float64Array;
  private readonly edgeCost: Map<number, number>;

  private readonly oneEuro: OneEuroVector | null;

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
      for (let d = 0; d < dims; d++) this.F[i * NDIMS + d] = data[i * dims + d];
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

    this.weights = Float64Array.from(WEIGHTS);
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

    this.oneEuro = oneEuro ?? null;
    this.reset();
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
    this.oneEuro?.reset();
  }

  // ------------------------------------------------------------------ inputs
  pushPose(tMs: number, mask: number, values: ArrayLike<number>, norm: 'raw' | 'cal' = 'raw'): void {
    let x: Float64Array<ArrayBufferLike> = new Float64Array(NDIMS);
    const len = Math.min(values.length, NDIMS);
    for (let i = 0; i < len; i++) x[i] = values[i];
    if (norm === 'cal') {
      const mapped = new Float64Array(NDIMS);
      for (let i = 0; i < NDIMS; i++) {
        const span = this.p95[i] - this.p05[i];
        const clamped = Math.min(1.2, Math.max(-1.2, x[i]));
        let m = this.p05[i] + (clamped + 1.0) * 0.5 * span;
        const lo = this.p05[i] - 0.1 * span;
        const hi = this.p95[i] + 0.1 * span;
        m = Math.min(Math.max(m, lo), hi);
        mapped[i] = m;
      }
      for (let i = 0; i < NDIMS; i++) x[i] = RETARGET[i] ? mapped[i] : x[i];
    }
    if (this.oneEuro) x = this.oneEuro.filterMasked(tMs, x, mask);
    const act = groupVector(mask);
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
    this.opt.mouth_policy = policy === 'mocap' ? 'mocap' : 'audio';
  }

  hasFreshPose(nowMs: number): boolean {
    return this.lastPoseAt !== null && nowMs - this.lastPoseAt <= this.opt.idle_after_ms;
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
        const diff = this.F[row + d] - x[d];
        s += diff * diff * this.Vmat[row + d] * wv[d];
      }
      S[i] = s;
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
    const w = Float64Array.from(this.weights);
    if (opt.mouth_policy === 'audio') {
      const env = this.envelope;
      let boosted = env < 0.06 ? 0.0 : Math.min(1.0, env * (0.4 + 1.6 * this.intensity));
      if (!this.talking) boosted = 0.0;
      x[DIM_INDEX.mouthOpen] = boosted;
      x[DIM_INDEX.jawOpen] = boosted;
      for (const name of ['mouthSmile', 'mouthFrown', 'mouthPucker', 'mouthWidth']) w[DIM_INDEX[name]] = 0.0;
      mask |= 1 << G_MOUTH;
    }
    const vLive = groupVector(mask);
    const wv = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) wv[d] = w[d] * vLive[d] * this.dimValid[d];

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
    const S = this.lastS as Float64Array;
    const den = this.lastDen as Float64Array;
    const globalC = this.lastGlobal;

    // ---- audio prior per sequence kind (also part of the teleport gate)
    const wA = opt.mouth_policy === 'audio' ? opt.w_a_audio : opt.w_a_mocap;
    const audioPrior = (j: number): number => {
      const kind = this.seqKindOf[j];
      if (mode === MODE_IDLE) return kind === SEQ_IDLE ? 0.0 : 1.0;
      if (opt.mouth_policy === 'mocap') {
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
    const teleportAllowed = mode === MODE_LIVE && nowMs - this.lastTeleportAt >= opt.teleport_cooldown_ms;

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

    // ---- state update
    const teleport = !bestIsEdge;
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
      debug: {
        E_best: eBest,
        S_best: Number.isFinite(S[bestJ]) ? S[bestJ] : -1.0,
        age_ms: Number.isFinite(age) ? age : -1.0,
        candidates: cands.size,
        ema_E: this.emaEBest,
        run_ticks: this.runTicks,
        dwell: this.dwellTicks,
      },
    };
  }

  // ------------------------------------------------------------------ diagnostics
  /** Live target minus the chosen frame's descriptor (for the affine warp). */
  residual(frame: number): Float64Array {
    const f = Math.trunc(frame);
    const out = new Float64Array(NDIMS);
    for (let d = 0; d < NDIMS; d++) out[d] = this.xHat[d] - this.F[f * NDIMS + d];
    return out;
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
