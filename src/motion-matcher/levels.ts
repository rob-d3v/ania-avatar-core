/**
 * Ania 2.0 reaction levels — one user dial, one option table, every port identical.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/levels.py`.
 *
 * The user picks **one** thing: how much of their face the avatar copies
 * (`off | presence | expressive | mirror`). Everything else — matcher dim gains,
 * mouth policy, teleport gate, One-Euro cutoffs, retarget gain, affine caps — is
 * derived here by the tables of the spec page
 * `Ania Creators/wiki/concepts/ania-2-0-reaction-levels.md` (§2), so the Python
 * reference runtime, this web engine and the legacy IIFE all resolve the same
 * numbers from the same six comfort keys.
 *
 * Two entry points:
 *
 * `probeCaps(poses, coverage)` — what the *bank* can physically show (§5.1).
 * `resolveOptions(comfort, caps)` — the six-key comfort object (§3) + the caps =>
 * every knob the matcher, the One-Euro filter and the affine warp need, plus a
 * `warnings` list of pt-BR sentences (§5.4) and the level actually granted.
 *
 * Design rule the tables encode (§2.1): the level never edits `WEIGHTS`. It produces
 * a per-dim gain vector and the matcher uses `w_i = WEIGHTS[i] * dimGain[i]`; a gain
 * of 0 drops the dim from both the numerator and the denominator, so `E_best` stays
 * comparable between levels.
 */

import {
  BROW_MAPPING_VERSION,
  DIM_GROUP,
  DIM_INDEX,
  G_BODY,
  G_BROWS,
  G_EYES,
  G_HAND_L,
  G_HAND_R,
  G_HEAD,
  G_MOUTH,
  G_RESERVED,
  NDIMS,
  groupVector,
} from './descriptor';
import { GROUP_PARAMS } from './one-euro';
import type { MatcherOptions, PosesBank } from './matcher';
import type { Coverage } from './coverage-builder';

export const LEVEL_OFF = 'off';
export const LEVEL_PRESENCE = 'presence';
export const LEVEL_EXPRESSIVE = 'expressive';
export const LEVEL_MIRROR = 'mirror';
export const LEVEL_ORDER = [LEVEL_OFF, LEVEL_PRESENCE, LEVEL_EXPRESSIVE, LEVEL_MIRROR] as const;

export type MocapLevel = (typeof LEVEL_ORDER)[number];
export type CrossfadeMode = 'auto' | 'on' | 'off';

/**
 * Which piece of software actually decides the frame.
 *
 *   `legacy`  the player's own AnimationController keeps playing its idle/talk sequences
 *             exactly as it always has (ping-pong, start points, openness map). The
 *             camera and the microphone only decide WHICH segment plays and WHEN to cut.
 *   `matcher` the MotionMatcher picks a frame per tick (the pre-pivot behaviour).
 *
 * The live verdict that forced this (2026-09-05, "é a transição... no Ania 1.0 é
 * bonitão"): per-frame matching at 25 Hz destroys the temporal coherence the legacy
 * playback has, and no amount of teleport gating brings it back — the transitions
 * themselves are the product.
 */
export const ENGINE_LEGACY = 'legacy';
export const ENGINE_MATCHER = 'matcher';
export type EngineMode = 'legacy' | 'matcher';

/**
 * Which frames of the bank a level may show.
 *
 *   `legacy` only the avatar's OWN frames — the ones inside its idle / talk / action
 *            ranges. Frames appended by an Ania 2.0 coverage upgrade (the manifest's
 *            `video.ania2.coverage` block, indexed as `orphan:*` sequences) are
 *            excluded: they come from a different render, and on 2026-09-05 the live
 *            session walked straight into that block ("os quadros mais aleatórios do
 *            mundo, com a câmera na mão").
 *   `all`    every frame, coverage included. Opt-in, `mirror` only.
 */
export const FRAME_POOL_LEGACY = 'legacy';
export const FRAME_POOL_ALL = 'all';
export const FRAME_POOLS = [FRAME_POOL_LEGACY, FRAME_POOL_ALL] as const;
export type FramePool = (typeof FRAME_POOLS)[number];

/**
 * §4.7 — `presence` blink detour: how far from the cursor an eye-closed frame may sit
 * and still be a cut nobody sees. Frames this close inside one sequence are
 * near-identical, so the cut in and the cut back read as the blink itself.
 */
export const BLINK_DETOUR_MAX_DELTA = 30;
export const BLINK_DETOUR_TICKS = 2;

/**
 * §4.8 — the user's microphone drives the LEGACY talk path (open fast, close slow, so an
 * intra-sentence pause does not drop the avatar back to idle).
 */
export const MIC_TALK_THRESHOLD = 0.12;
export const MIC_TALK_OPEN_TICKS = 1;
export const MIC_TALK_CLOSE_TICKS = 8;

/**
 * The brow mapping was a constant (+1.00 on 100 % of frames of both drivers) up to
 * revision 1; §5.1's driver-side gate forced `caps.brows = 0` while that was true.
 * `descriptor.BROW_MAPPING_VERSION` is bumped by the re-fit, which lifts the gate.
 */
export const BROW_GATE_MIN_MAPPING_VERSION = 2;

// §3 ranges
export const INTENSITY_MIN = 0.5;
export const INTENSITY_MAX = 1.5;
export const SMOOTHING_MIN = 0.5;
export const SMOOTHING_MAX = 2.0;
export const RETARGET_GAIN_MIN = 0.4;
export const RETARGET_GAIN_MAX = 1.9;
export const CROSSFADE_MODES: readonly CrossfadeMode[] = ['auto', 'on', 'off'];

/**
 * Where the user's mouth-OPEN value comes from once the level hands the mouth over.
 * `audio` means it never does (the avatar's own voice keeps it) — that is `presence`.
 */
export const MOUTH_SOURCES = ['audio', 'camera', 'mic', 'hybrid'] as const;
export type MouthSource = (typeof MOUTH_SOURCES)[number];

/**
 * Live feedback 2026-09-05 ("acho que nem meu mic tá sendo usado"): a webcam delivers
 * 11-13 descriptors/s in the running player, which cannot resolve syllables, so the
 * levels that hand the mouth over default to the microphone blended with the camera.
 */
export const LEVEL_MOUTH_SOURCE: Record<string, MouthSource> = {
  [LEVEL_OFF]: 'audio',
  // At `presence` the blend does NOT reach the matcher: it is fed to the player's own
  // lip-sync path (see `engine`), which is what Ania 1.0 does with the TTS waveform.
  [LEVEL_PRESENCE]: 'hybrid',
  [LEVEL_EXPRESSIVE]: 'hybrid',
  [LEVEL_MIRROR]: 'hybrid',
};

// §4.2 — a transition this expensive is a visible jump and needs a blend
export const CROSSFADE_COST = 6.0;
export const CROSSFADE_MS = 120.0;
export const CROSSFADE_TICKS = 3;

// §4.3 — mouth handover hysteresis
export const MOUTH_HANDOVER_MS = 250.0;

// §4.4 — breathing
export const BREATHING_DWELL_TICKS = 25;
export const BREATHING_COST_BONUS = 0.004;

// §5.1 thresholds
export const CAP_FACE_MIN_PCT = 0.6;
export const CAP_HEAD_SPAN = 0.3;
export const CAP_HEAD_FILLED = 4;
export const CAP_BLINK_P95 = 0.5;
export const CAP_MOUTH_P95 = 0.3;
export const CAP_MOUTH_FILLED = 2;
export const CAP_SMILE_SPAN = 0.15;
export const CAP_SMILE_P95 = 0.3;
export const CAP_GAZE_SPAN = 0.1;
export const CAP_BROWS_SPAN = 0.15;
export const CAP_BROWS_FILLED = 2;
export const CAP_HAND_VIS_COUNT = 3;
export const CAP_HAND_Y_FILLED = 2;
export const CAP_PUCKER_P95 = 0.3;
export const CAP_WIDTH_SPAN = 0.4;

export const HEAD_YAW_DEG_PER_UNIT = 30.0;

// ---------------------------------------------------------------- i18n (§5.4)
export const STRINGS: Record<string, string> = {
  'mocap.level.blocked.noIndex':
    'Este avatar ainda não tem índice de pose. Gere o modelo Ania 2.0 para usar as reações.',
  'mocap.level.blocked.noFace':
    'Este personagem é estilizado e o detector não encontra rosto nele: as reações não estão disponíveis.',
  'mocap.level.blocked.noBlink':
    'Este avatar não tem piscadas indexadas: as reações não estão disponíveis. Gere a cobertura de piscar.',
  'mocap.level.blocked.needHead':
    'Espelho precisa que o avatar vire a cabeça, e este só vira {deg}°. Gere a cobertura de giro de cabeça.',
  'mocap.level.blocked.needMouth':
    'Espelho precisa da boca indexada, e este avatar não tem. Gere a cobertura de fala.',
  'mocap.level.warn.noBrows':
    'Este avatar não tem sobrancelhas indexadas: Expressivo vai usar só olhos e sorriso.',
  // Live feedback 2026-09-05 ("mexo as mãos, ela não mexe"): the sentence has to name the
  // missing thing (frames of hands) and the fix (generate gesture coverage), not the
  // internal word "indexadas".
  'mocap.level.warn.noHands': 'Este avatar não tem quadros de mãos; gere cobertura de gestos.',
  'mocap.level.warn.noMouth':
    'Este avatar não tem boca de câmera indexada: Expressivo vai manter a boca pelo áudio o tempo todo.',
  'mocap.level.warn.narrowYaw':
    'Este avatar só vira a cabeça {deg}°: ele vai acompanhar você deslizando, sem virar. Gere a cobertura de giro de cabeça.',
  'mocap.level.warn.noGaze':
    'Este avatar não tem o olhar indexado: Expressivo não vai seguir você com os olhos.',
  'mocap.level.warn.noBlend': 'Sem suavização de cortes neste player: o Espelho vai cortar seco.',
};

/** UI copy (§1). */
export const LEVEL_UI: Record<string, { name: string; subtitle: string }> = {
  [LEVEL_OFF]: { name: 'Desligado', subtitle: 'O avatar anima só pelo áudio, como sempre.' },
  [LEVEL_PRESENCE]: {
    name: 'Sutil (recomendado)',
    subtitle:
      'O avatar anima como sempre; você só dá o ritmo — fala pelo seu microfone, pisca quando você pisca.',
  },
  [LEVEL_EXPRESSIVE]: {
    name: 'Expressivo',
    subtitle: 'Além disso: olhos, sorriso e mãos — o que este avatar tiver.',
  },
  [LEVEL_MIRROR]: {
    name: 'Espelho (experimental)',
    subtitle: 'Copia tudo quadro a quadro, inclusive a boca. Pode parecer estranho.',
  },
};

export interface LevelGain {
  head: number;
  mouth: number;
  blink: number;
  eyes: number;
  brows: number;
  body: number;
  hands: number;
}

export interface LevelComfortDefaults {
  intensity: number;
  smoothing: number;
  crossfade: CrossfadeMode;
  breathing: boolean;
  mirror: boolean;
}

export interface LevelAffine {
  base_strength: number;
  max_translate_frac: number;
  max_rotate_deg: number;
  max_scale_dev: number;
  /** Head-only mode caps (`paramsForHead`): much tighter, because a head that slides
   * away from a static body opens a seam at the collar. */
  head_max_translate_frac: number;
  head_max_rotate_deg: number;
}

export interface LevelSpec {
  ui: { name: string; subtitle: string };
  active: boolean;
  /** Who picks the frame at this level (2026-09-05 pivot). */
  engine?: EngineMode;
  /** Which frames of the bank this level may show. */
  frame_pool?: FramePool;
  /** Whether a residual affine warp is computed at all. */
  affine_enabled?: boolean;
  gain?: LevelGain;
  matcher?: Partial<MatcherOptions> & Record<string, unknown>;
  retarget_gain?: number;
  one_euro?: Record<number, number>;
  affine?: LevelAffine;
  comfort?: LevelComfortDefaults;
  hold_ms?: number;
}

/**
 * `mouth` here is the gain the MOUTH dims get while the camera owns the mouth
 * (`mouth_policy === "mocap"`). While the audio owns it the mouth dims are 0 by
 * construction: the matcher overwrites mouthOpen/jawOpen with the lip-sync envelope
 * and zeroes the four expression weights, so no driver mouth value reaches the cost.
 */
export const LEVELS: Record<string, LevelSpec> = {
  [LEVEL_OFF]: {
    ui: LEVEL_UI[LEVEL_OFF],
    active: false,
  },
  // ---------------------------------------------------------------- Sutil (the default)
  // Redefined 2026-09-05 after the second live test. The user loved the FIRST session
  // ("piscar e sorrir 100 %, avatar quase estático") and rejected the frame-by-frame one
  // ("é a transição... no Ania 1.0 é bonitão... ela nem tá falando quando eu falo"). So
  // `presence` no longer picks frames at all:
  //   * the legacy AnimationController keeps playing its own idle/talk sequences,
  //   * the user's MICROPHONE drives the player's existing lip-sync path (talk range +
  //     openness map) exactly the way a TTS waveform does,
  //   * a blink is a 2-tick detour to an eye-closed frame INSIDE the current sequence,
  //     handed straight back at the same position,
  //   * smile / head yaw only bias the frame the cycler picks at a cut point,
  //   * no affine warp, no teleports, no generated coverage frames.
  // The matcher is still built (it holds the descriptors, the blink index and the pose
  // filter) — its `step()` simply does not choose what the viewer sees.
  [LEVEL_PRESENCE]: {
    ui: LEVEL_UI[LEVEL_PRESENCE],
    active: true,
    engine: ENGINE_LEGACY,
    frame_pool: FRAME_POOL_LEGACY,
    affine_enabled: false,
    gain: { head: 1.0, mouth: 1.0, blink: 1.0, eyes: 0.0, brows: 0.0, body: 0.6, hands: 0.0 },
    matcher: {
      mouth_policy: 'audio',
      allow_teleport: false,
      teleport_min_gain: 0.35,
      teleport_cooldown_ms: 1200.0,
      min_run_ticks: 4,
      step_penalty: 0.002,
      lookahead_w: 0.5,
      stale_ms: 400.0,
      decay_tau_ms: 130.0,
      idle_after_ms: 3000.0,
      hold_free_ticks: 6,
      hold_penalty_per_tick: 0.002,
      hold_penalty_max: 0.012,
      w_a_audio: 0.3,
      w_a_mocap: 0.1,
      talking_forces_audio: true,
      // a blink is an event, not a pose (see MatcherOptions.blink_event). ARTICULATE is
      // OFF here: the mouth is articulated by the player's own openness map through the
      // legacy talk path, not by the matcher.
      blink_event: true,
      articulate: false,
    },
    retarget_gain: 0.85,
    one_euro: {
      [G_HEAD]: 0.8,
      [G_MOUTH]: 1.0,
      [G_EYES]: 1.0,
      [G_BROWS]: 1.0,
      [G_BODY]: 0.8,
      [G_HAND_L]: 1.0,
      [G_HAND_R]: 1.0,
    },
    // kept for the option table's shape; `affine_enabled: false` means no warp is ever
    // computed at this level, and `strength` resolves to 0.
    affine: {
      base_strength: 0.0,
      max_translate_frac: 0.06,
      max_rotate_deg: 6.0,
      max_scale_dev: 0.04,
      head_max_translate_frac: 0.03,
      head_max_rotate_deg: 4.0,
    },
    comfort: { intensity: 0.9, smoothing: 0.9, crossfade: 'off', breathing: true, mirror: true },
    hold_ms: 0.0,
  },
  [LEVEL_EXPRESSIVE]: {
    ui: LEVEL_UI[LEVEL_EXPRESSIVE],
    active: true,
    engine: ENGINE_MATCHER,
    frame_pool: FRAME_POOL_LEGACY,
    affine_enabled: true,
    gain: { head: 1.0, mouth: 0.6, blink: 1.0, eyes: 1.0, brows: 1.0, body: 1.0, hands: 1.0 },
    matcher: {
      mouth_policy: 'auto',
      allow_teleport: true,
      teleport_min_gain: 0.35,
      teleport_cooldown_ms: 1200.0,
      min_run_ticks: 3,
      step_penalty: 0.001,
      lookahead_w: 0.5,
      stale_ms: 400.0,
      decay_tau_ms: 130.0,
      idle_after_ms: 3000.0,
      hold_free_ticks: 6,
      hold_penalty_per_tick: 0.002,
      hold_penalty_max: 0.012,
      w_a_audio: 0.3,
      w_a_mocap: 0.1,
      talking_forces_audio: true,
      // a blink is an event, not a pose (see MatcherOptions.blink_event); ARTICULATE
      // self-gates on mouth_policy === "mocap", so it is inert at `presence` and arms
      // itself the moment the camera/mic owns the mouth
      blink_event: true,
      articulate: true,
    },
    retarget_gain: 1.0,
    one_euro: {
      [G_HEAD]: 1.0,
      [G_MOUTH]: 1.0,
      [G_EYES]: 1.0,
      [G_BROWS]: 1.0,
      [G_BODY]: 1.0,
      [G_HAND_L]: 1.0,
      [G_HAND_R]: 1.0,
    },
    affine: {
      base_strength: 1.0,
      max_translate_frac: 0.1,
      max_rotate_deg: 10.0,
      max_scale_dev: 0.08,
      head_max_translate_frac: 0.05,
      head_max_rotate_deg: 6.0,
    },
    comfort: { intensity: 1.0, smoothing: 1.0, crossfade: 'auto', breathing: true, mirror: true },
    hold_ms: 180.0,
  },
  [LEVEL_MIRROR]: {
    ui: LEVEL_UI[LEVEL_MIRROR],
    active: true,
    engine: ENGINE_MATCHER,
    // the only level that may enter a generated coverage block, and only because the
    // user explicitly picked the experimental one
    frame_pool: FRAME_POOL_ALL,
    affine_enabled: true,
    gain: { head: 1.0, mouth: 1.0, blink: 1.0, eyes: 1.0, brows: 1.0, body: 1.0, hands: 1.0 },
    matcher: {
      mouth_policy: 'mocap',
      allow_teleport: true,
      teleport_min_gain: 0.15,
      teleport_cooldown_ms: 500.0,
      min_run_ticks: 2,
      step_penalty: 0.001,
      lookahead_w: 0.35,
      stale_ms: 400.0,
      decay_tau_ms: 130.0,
      idle_after_ms: 3000.0,
      hold_free_ticks: 6,
      hold_penalty_per_tick: 0.002,
      hold_penalty_max: 0.012,
      w_a_audio: 0.3,
      w_a_mocap: 0.1,
      talking_forces_audio: true,
      // a blink is an event, not a pose (see MatcherOptions.blink_event); ARTICULATE
      // self-gates on mouth_policy === "mocap", so it is inert at `presence` and arms
      // itself the moment the camera/mic owns the mouth
      blink_event: true,
      articulate: true,
    },
    retarget_gain: 1.25,
    one_euro: {
      [G_HEAD]: 1.3,
      [G_MOUTH]: 1.3,
      [G_EYES]: 1.0,
      [G_BROWS]: 1.2,
      [G_BODY]: 1.2,
      [G_HAND_L]: 1.2,
      [G_HAND_R]: 1.2,
    },
    affine: {
      base_strength: 1.0,
      max_translate_frac: 0.14,
      max_rotate_deg: 12.0,
      max_scale_dev: 0.1,
      head_max_translate_frac: 0.05,
      head_max_rotate_deg: 6.0,
    },
    comfort: { intensity: 1.1, smoothing: 1.2, crossfade: 'on', breathing: false, mirror: true },
    hold_ms: 120.0,
  },
};

/** §5.2 — caps that block a level outright vs caps that only warn. */
export const BLOCKERS: Record<string, readonly string[]> = {
  [LEVEL_PRESENCE]: ['face', 'blink'],
  [LEVEL_EXPRESSIVE]: ['face', 'blink'],
  [LEVEL_MIRROR]: ['face', 'blink', 'head', 'mouth'],
};
export const WARNERS: Record<string, readonly string[]> = {
  [LEVEL_PRESENCE]: ['head'],
  [LEVEL_EXPRESSIVE]: ['smile', 'gaze', 'brows', 'hands', 'mouth'],
  [LEVEL_MIRROR]: ['mouthShapes', 'hands', 'brows'],
};
const BLOCK_KEY: Record<string, string> = {
  face: 'mocap.level.blocked.noFace',
  blink: 'mocap.level.blocked.noBlink',
  head: 'mocap.level.blocked.needHead',
  mouth: 'mocap.level.blocked.needMouth',
};
const WARN_KEY: Record<string, string | null> = {
  head: 'mocap.level.warn.narrowYaw',
  brows: 'mocap.level.warn.noBrows',
  hands: 'mocap.level.warn.noHands',
  mouth: 'mocap.level.warn.noMouth',
  gaze: 'mocap.level.warn.noGaze',
  smile: null,
  mouthShapes: null,
};
/** Channel labels for the "olhos · sorriso · boca" line (§2.6). */
export const CHANNEL_LABEL: Record<string, string> = {
  head: 'cabeça',
  blink: 'piscadas',
  gaze: 'olhar',
  smile: 'sorriso',
  mouth: 'boca',
  brows: 'sobrancelhas',
  hands: 'mãos',
};
const CHANNEL_ORDER = ['head', 'blink', 'gaze', 'smile', 'mouth', 'brows', 'hands'] as const;

function clampf(v: unknown, lo: number, hi: number, dflt: number): number {
  const f = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(f)) return dflt;
  return f < lo ? lo : f > hi ? hi : f;
}

function fillText(key: string, kw: Record<string, unknown> = {}): string {
  let s = STRINGS[key] ?? key;
  for (const k of Object.keys(kw)) s = s.split(`{${k}}`).join(String(kw[k]));
  return s;
}

/** One i18n string from §5.4 with its placeholders filled. */
export function text(key: string, kw: Record<string, unknown> = {}): string {
  return fillText(key, kw);
}

// ------------------------------------------------------------------ capability probe
export interface MocapCaps {
  face: number;
  head: number;
  blink: number;
  mouth: number;
  smile: number;
  gaze: number;
  brows: number;
  hands: number;
  mouthShapes: number;
  /** Renderer capability: can the host composite two frames? Defaulted to 1. */
  blend: number;
  metrics: Record<string, number>;
  reason?: string;
  [key: string]: unknown;
}

type CoverageLike = Coverage | { bins?: Record<string, { counts?: ArrayLike<number>; edges?: ArrayLike<number> }> } | null | undefined;

function binCounts(coverage: CoverageLike, dim: string): number[] {
  if (!coverage) return [];
  const bins = (coverage as { bins?: Record<string, { counts?: ArrayLike<number> }> }).bins;
  const b = bins ? bins[dim] : undefined;
  if (!b || !b.counts) return [];
  return Array.from(b.counts, (c) => Math.trunc(Number(c)));
}

function filled(coverage: CoverageLike, dim: string, minCount = 3): number {
  let n = 0;
  for (const c of binCounts(coverage, dim)) if (c >= minCount) n++;
  return n;
}

/** NumPy's linear-interpolation percentile over a pre-sorted ascending array. */
function percentileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = ((n - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function pyRound(v: number, digits: number): number {
  const f = 10 ** digits;
  const x = v * f;
  const r = Math.round(x);
  // banker's rounding on the exact .5 case, as Python's round() does
  const out = Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - Math.sign(x) : r;
  return out / f;
}

/**
 * What this bank can physically show (§5.1). Pure; same thresholds in every port.
 *
 * `poses` is a parsed `poses.json`; `coverage` a parsed `coverage.json` (bins with
 * `count >= 3` are "filled"). Returns 0/1 caps plus a `metrics` block the UI needs
 * to word its sentences, and `blend` (renderer capability) defaulted to 1 — the
 * caller overwrites it at attach time.
 */
export function probeCaps(
  poses: PosesBank | null | undefined,
  coverage?: CoverageLike,
  browMappingVersion?: number,
): MocapCaps {
  const caps = {
    face: 0,
    head: 0,
    blink: 0,
    mouth: 0,
    smile: 0,
    gaze: 0,
    brows: 0,
    hands: 0,
    mouthShapes: 0,
    blend: 1,
    metrics: {} as Record<string, number>,
  } as MocapCaps;
  if (!poses) {
    caps.reason = 'mocap.level.blocked.noIndex';
    return caps;
  }
  const n = Math.trunc(Number(poses.frameCount ?? 0)) || 0;
  const dims = Math.trunc(Number(poses.dims ?? 0)) || 0;
  if (n <= 0 || dims <= 0) {
    caps.reason = 'mocap.level.blocked.noIndex';
    return caps;
  }
  const data = poses.data;
  const masks = poses.mask ? Array.from(poses.mask, (m) => Math.trunc(Number(m))) : new Array(n).fill(0xff);

  let faceBits = 0;
  for (let i = 0; i < n; i++) faceBits += (masks[i] >> G_HEAD) & 1;
  const facePct = faceBits / n;
  caps.metrics.facePct = pyRound(facePct, 4);
  caps.face = facePct >= CAP_FACE_MIN_PCT ? 1 : 0;

  const stats = (name: string, group: number): { p05: number; p95: number; span: number } | null => {
    const di = DIM_INDEX[name];
    if (di === undefined || di >= dims) return null;
    const v: number[] = [];
    for (let i = 0; i < n; i++) if (((masks[i] >> group) & 1) > 0) v.push(Number(data[i * dims + di]));
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    const p05 = percentileSorted(v, 5);
    const p95 = percentileSorted(v, 95);
    return { p05, p95, span: p95 - p05 };
  };

  const yaw = stats('headYaw', G_HEAD);
  const bl = stats('eyeBlinkL', G_EYES);
  const br = stats('eyeBlinkR', G_EYES);
  const mo = stats('mouthOpen', G_MOUTH);
  const sm = stats('mouthSmile', G_MOUTH);
  const gz = stats('gazeX', G_EYES);
  const bw = stats('browRaise', G_BROWS);
  const pk = stats('mouthPucker', G_MOUTH);
  const wd = stats('mouthWidth', G_MOUTH);

  const yawSpan = yaw ? yaw.span : 0.0;
  caps.metrics.headYawSpan = pyRound(yawSpan, 4);
  caps.metrics.headYawSpanDeg = pyRound(yawSpan * HEAD_YAW_DEG_PER_UNIT, 1);
  caps.metrics.headYawFilled = filled(coverage, 'headYaw');
  caps.head = yawSpan >= CAP_HEAD_SPAN && filled(coverage, 'headYaw') >= CAP_HEAD_FILLED ? 1 : 0;

  const blinkP95 = Math.max(bl ? bl.p95 : 0.0, br ? br.p95 : 0.0);
  caps.metrics.blinkP95 = pyRound(blinkP95, 4);
  caps.blink = blinkP95 >= CAP_BLINK_P95 && filled(coverage, 'eyeBlinkL') === 2 ? 1 : 0;

  caps.metrics.mouthOpenP95 = mo ? pyRound(mo.p95, 4) : 0.0;
  caps.mouth = mo && mo.p95 >= CAP_MOUTH_P95 && filled(coverage, 'mouthOpen') >= CAP_MOUTH_FILLED ? 1 : 0;

  caps.smile = sm && sm.span >= CAP_SMILE_SPAN && sm.p95 >= CAP_SMILE_P95 ? 1 : 0;
  caps.gaze = gz && gz.span >= CAP_GAZE_SPAN ? 1 : 0;

  const browOk = !!bw && bw.span >= CAP_BROWS_SPAN && filled(coverage, 'browRaise') >= CAP_BROWS_FILLED;
  const bmv = browMappingVersion === undefined ? BROW_MAPPING_VERSION : Math.trunc(browMappingVersion);
  caps.metrics.browMappingVersion = bmv;
  // §5.1 driver-side gate: while `browRaise` is a saturated constant on the capture
  // side, brow matching is a coin flip dressed as a feature — force the cap to 0.
  caps.brows = browOk && bmv >= BROW_GATE_MIN_MAPPING_VERSION ? 1 : 0;

  const lvis = binCounts(coverage, 'handL_vis');
  const rvis = binCounts(coverage, 'handR_vis');
  const visOk =
    (lvis.length > 1 && lvis[1] >= CAP_HAND_VIS_COUNT) || (rvis.length > 1 && rvis[1] >= CAP_HAND_VIS_COUNT);
  const yOk = filled(coverage, 'handL_y') >= CAP_HAND_Y_FILLED || filled(coverage, 'handR_y') >= CAP_HAND_Y_FILLED;
  caps.hands = visOk && yOk ? 1 : 0;

  caps.mouthShapes = (pk && pk.p95 >= CAP_PUCKER_P95) || (wd && wd.span >= CAP_WIDTH_SPAN) ? 1 : 0;
  return caps;
}

// ------------------------------------------------------------------ option resolution
/**
 * Per-dim multiplier applied to `WEIGHTS` (§2.1). MOUTH carries the *camera* gain;
 * while the audio owns the mouth the matcher zeroes the driver's contribution itself.
 */
export function dimGainFor(level: string, caps: Partial<MocapCaps>): Float64Array {
  const g = LEVELS[level].gain as LevelGain;
  const out = new Float64Array(NDIMS);
  for (let i = 0; i < NDIMS; i++) {
    const grp = DIM_GROUP[i];
    if (grp === G_HEAD) out[i] = g.head;
    else if (grp === G_MOUTH) out[i] = g.mouth * (caps.mouth ?? 1 ? 1.0 : 0.0);
    else if (grp === G_EYES) out[i] = i === DIM_INDEX.eyeBlinkL || i === DIM_INDEX.eyeBlinkR ? g.blink : g.eyes;
    else if (grp === G_BROWS) out[i] = g.brows * (caps.brows ? 1.0 : 0.0);
    else if (grp === G_BODY) out[i] = g.body;
    else if (grp === G_HAND_L || grp === G_HAND_R) out[i] = g.hands * (caps.hands ? 1.0 : 0.0);
    else if (grp === G_RESERVED) out[i] = 0.0;
  }
  return out;
}

/**
 * Per-dim One-Euro min-cutoff (§2.4). EYES is pinned at its base 3.0 Hz at every level
 * and for every slider position — a filtered blink is a lost blink.
 */
export function oneEuroMinCutoff(level: string, smoothing = 1.0): Float64Array {
  const scales = (LEVELS[level].one_euro ?? {}) as Record<number, number>;
  const out = new Float64Array(NDIMS);
  for (let i = 0; i < NDIMS; i++) {
    const grp = DIM_GROUP[i];
    const base = GROUP_PARAMS[grp][0];
    if (grp === G_EYES) out[i] = base;
    else out[i] = base * (scales[grp] ?? 1.0) * smoothing;
  }
  return out;
}

/**
 * §4.2 trigger, as a pure function so every port and the tests agree.
 *
 * A transition costs `>= CROSSFADE_COST` (6) when it is a visible jump — every
 * teleport included, whose `c_jump` is 8. `auto` blends wherever the renderer can;
 * `off` never; `on` blends but degrades to never on a renderer that cannot composite
 * (and then the teleport is not taken at all, see {@link resolveOptions}).
 */
export function shouldCrossfade(transitionCost: number, crossfade: string, canBlend = true): boolean {
  if (!canBlend) return false;
  if (crossfade === 'off') return false;
  const c = Number(transitionCost);
  if (!Number.isFinite(c)) return false;
  return c >= CROSSFADE_COST;
}

/** `alpha(t) = clamp(t / min(120 ms, 3 ticks), 0, 1)` — the new frame's weight. */
export function crossfadeAlpha(elapsedMs: number, durationMs: number = CROSSFADE_MS): number {
  const d = Number(durationMs);
  if (!(d > 0)) return 1.0;
  const a = Number(elapsedMs) / d;
  return a < 0 ? 0.0 : a > 1 ? 1.0 : a;
}

export interface MocapComfort {
  level: string;
  intensity: number;
  smoothing: number;
  crossfade: CrossfadeMode;
  breathing: boolean;
  mirror: boolean;
  /** Advanced, additive: where the user's mouth-OPEN value comes from. */
  mouth_source?: MouthSource;
  /** Advanced, additive: override the level's candidate policy. */
  frame_pool?: FramePool;
}

/** The six keys, in spec order, at their per-level defaults (§3.1). */
export function defaultComfort(level: string): MocapComfort {
  const lv = level in LEVELS ? level : LEVEL_OFF;
  if (!LEVELS[lv].active) {
    return { level: LEVEL_OFF, intensity: 1.0, smoothing: 1.0, crossfade: 'auto', breathing: true, mirror: true };
  }
  const c = LEVELS[lv].comfort as LevelComfortDefaults;
  return {
    level: lv,
    intensity: c.intensity,
    smoothing: c.smoothing,
    crossfade: c.crossfade,
    breathing: c.breathing,
    mirror: c.mirror,
  };
}

/** The wire form (§3.2): the six keys, in that order, lower-camel, no nesting. */
export function serializeComfort(comfort: Partial<MocapComfort> | null | undefined): MocapComfort {
  const c = comfort || {};
  return {
    level: c.level ?? LEVEL_OFF,
    intensity: c.intensity ?? 1.0,
    smoothing: c.smoothing ?? 1.0,
    crossfade: c.crossfade ?? 'auto',
    breathing: !!(c.breathing ?? true),
    mirror: !!(c.mirror ?? true),
  };
}

export interface MocapWarning {
  key: string;
  text: string;
}

export interface ResolvedAffine {
  /** `false` at a level that never warps (`presence`); `strength` is then 0 too. */
  enabled?: boolean;
  strength: number;
  max_translate_frac: number;
  max_rotate_deg: number;
  max_scale_dev: number;
  head_max_translate_frac: number;
  head_max_rotate_deg: number;
  breathing: boolean;
}

export interface ResolvedOptions {
  level: string;
  requested_level: string;
  blocked: boolean;
  active: boolean;
  comfort: MocapComfort;
  crossfade?: CrossfadeMode;
  can_blend?: boolean;
  /** Where the user's mouth-OPEN value comes from at this level. */
  mouth_source?: MouthSource;
  /** Whether this level wants a microphone envelope fed via `setMicOpenness`. */
  needs_mic?: boolean;
  /** `legacy` = Ania 1.0 cycling + the Sutil hooks; `matcher` = frame-by-frame. */
  engine?: EngineMode;
  /** Which frames the matcher may land on (`legacy` excludes the coverage blocks). */
  frame_pool?: FramePool;
  /** Whether a residual affine warp is computed at all at this level. */
  affine_enabled?: boolean;
  /** §Sutil hook 2: a blink detours into the current sequence. */
  blink_detour?: boolean;
  /** §Sutil hook 3: the cycler's start point is biased toward the user. */
  start_point_bias?: boolean;
  /** §Sutil hook 1: the user's mic drives the legacy talk path. */
  mic_talk?: boolean;
  matcher?: Partial<MatcherOptions> & Record<string, unknown>;
  one_euro_min_cutoff?: Float64Array;
  affine?: ResolvedAffine;
  retarget_gain?: number;
  hold_ms?: number;
  mirror?: boolean;
  breathing?: boolean;
  caps: Partial<MocapCaps>;
  channels: string[];
  missing_channels?: string[];
  warnings: MocapWarning[];
  ui?: { name: string; subtitle: string };
}

/**
 * Comfort object + bank capabilities -> every knob, plus the pt-BR warnings.
 *
 * Never throws and never silently downgrades: when a level is blocked the result
 * carries the granted level, `blocked = true`, the requested level and a warning
 * naming the missing thing and the fix (§5.4).
 */
export function resolveOptions(
  comfort: Partial<MocapComfort> | null | undefined,
  caps?: Partial<MocapCaps> | null,
): ResolvedOptions {
  const c: Partial<MocapCaps> = { ...(caps || {}) };
  if (c.blend === undefined) c.blend = 1;
  let requested = (comfort || {}).level ?? LEVEL_OFF;
  if (!(requested in LEVELS)) requested = LEVEL_OFF;

  const warnings: MocapWarning[] = [];
  const seen = new Set<string>();
  const deg = ((c.metrics as Record<string, number> | undefined) || {}).headYawSpanDeg ?? 0;
  const warn = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({ key, text: fillText(key, { deg }) });
  };

  // ---- caps gating (§5.2): walk down until a level's blockers are all satisfied
  let level = requested;
  let blocked = false;
  while (LEVELS[level].active) {
    const missing = (BLOCKERS[level] || []).filter((k) => !c[k]);
    if (!missing.length) break;
    blocked = true;
    for (const k of missing) warn(BLOCK_KEY[k]);
    level = LEVEL_ORDER[LEVEL_ORDER.indexOf(level as MocapLevel) - 1];
  }

  if (!LEVELS[level].active) {
    return {
      level: LEVEL_OFF,
      requested_level: requested,
      blocked,
      active: false,
      warnings,
      caps: c,
      comfort: serializeComfort(defaultComfort(LEVEL_OFF)),
      channels: [],
      // `off` is legacy playback with no hooks at all: the controller must behave exactly
      // as it did before mocap existed, which is what keeps verify.mjs frame-identical.
      engine: ENGINE_LEGACY,
      frame_pool: FRAME_POOL_LEGACY,
      affine_enabled: false,
      blink_detour: false,
      start_point_bias: false,
      mic_talk: false,
      mouth_source: 'audio',
      needs_mic: false,
    };
  }

  // ---- comfort: level defaults, user overrides, clamps (§3)
  const d = LEVELS[level].comfort as LevelComfortDefaults;
  const src = (comfort || {}) as Partial<MocapComfort>;
  const intensity = clampf(src.intensity ?? d.intensity, INTENSITY_MIN, INTENSITY_MAX, d.intensity);
  const smoothing = clampf(src.smoothing ?? d.smoothing, SMOOTHING_MIN, SMOOTHING_MAX, d.smoothing);
  let crossfade = (src.crossfade ?? d.crossfade) as CrossfadeMode;
  if (!CROSSFADE_MODES.includes(crossfade)) crossfade = d.crossfade;
  const breathing = !!(src.breathing ?? d.breathing);
  const mirror = !!(src.mirror ?? d.mirror);

  // ---- warnings for the caps that only degrade the level
  for (const k of WARNERS[level] || []) {
    if (c[k]) continue;
    const key = WARN_KEY[k];
    if (key) warn(key);
  }

  // ---- crossfade / renderer fallback (§4.2)
  const canBlend = !!c.blend;
  let crossfadeEffective: CrossfadeMode = crossfade;
  const matcher: Record<string, unknown> = { ...(LEVELS[level].matcher as Record<string, unknown>) };
  if (!canBlend) {
    if (crossfade === 'on' || crossfade === 'auto') {
      crossfadeEffective = 'off';
      // a jump that cannot be hidden is not taken
      matcher.allow_teleport = false;
      matcher.min_run_ticks = Math.trunc(Number(matcher.min_run_ticks)) + 1;
      if (level === LEVEL_MIRROR) warn('mocap.level.warn.noBlend');
    }
  }

  // ---- where the user's mouth-open value comes from (mic / camera / hybrid)
  let mouthSource = ((comfort || {}) as { mouth_source?: MouthSource }).mouth_source || LEVEL_MOUTH_SOURCE[level];
  if (!MOUTH_SOURCES.includes(mouthSource)) mouthSource = LEVEL_MOUTH_SOURCE[level];
  // `off` only: nothing of the user reaches the mouth.
  if (!allowsCameraMouth(level)) mouthSource = 'audio';
  matcher.mouth_blend = mouthSource === 'audio' || mouthSource === 'camera' ? 'camera' : mouthSource;

  // ---- matcher
  matcher.mouth_camera_allowed = !!c.mouth;
  if (!matcher.mouth_camera_allowed && matcher.mouth_policy === 'auto') {
    matcher.mouth_policy = 'audio'; // §4.3: the switch never arms
  }

  // ---- candidate pool: which frames of the bank this level may show at all
  const poolDefault = framePoolOf(level);
  let framePool = ((comfort || {}) as { frame_pool?: FramePool }).frame_pool || poolDefault;
  if (!FRAME_POOLS.includes(framePool)) framePool = poolDefault;
  matcher.frame_pool = framePool;
  const engine = engineOf(level);
  matcher.dim_gain = Array.from(dimGainFor(level, c));
  matcher.use_reach = true;
  const baseGain = LEVELS[level].retarget_gain as number;
  matcher.retarget_gain = clampf(baseGain * intensity, RETARGET_GAIN_MIN, RETARGET_GAIN_MAX, baseGain);
  matcher.hold_ms = LEVELS[level].hold_ms as number;
  matcher.breathing = breathing;
  matcher.mouth_handover_ms = MOUTH_HANDOVER_MS;

  // ---- affine (§2.5): extra reach comes from the caps, never from strength > 1.
  // `presence` has no warp at all (affine_enabled false, base_strength 0): a warped head
  // on top of a legacy-played sequence is exactly the "sticker" the live test rejected.
  const affineEnabled = LEVELS[level].affine_enabled !== false;
  const a = LEVELS[level].affine as LevelAffine;
  const affine: ResolvedAffine = {
    strength: affineEnabled ? Math.min(1.0, a.base_strength * intensity) : 0.0,
    max_translate_frac: a.max_translate_frac,
    max_rotate_deg: a.max_rotate_deg,
    max_scale_dev: a.max_scale_dev,
    // head-only mode caps (`affine.paramsForHead`): much tighter, because a head that
    // slides away from a static body opens a seam at the collar
    head_max_translate_frac: a.head_max_translate_frac,
    head_max_rotate_deg: a.head_max_rotate_deg,
    enabled: affineEnabled,
    breathing,
  };

  const channels = CHANNEL_ORDER.filter((k) => c[k]).map((k) => CHANNEL_LABEL[k]);
  const missingChannels = CHANNEL_ORDER.filter((k) => !c[k]).map((k) => CHANNEL_LABEL[k]);

  return {
    level,
    requested_level: requested,
    blocked,
    active: true,
    comfort: { level, intensity, smoothing, crossfade, breathing, mirror },
    crossfade: crossfadeEffective,
    can_blend: canBlend,
    mouth_source: mouthSource,
    needs_mic: mouthSource === 'mic' || mouthSource === 'hybrid',
    // who decides the frame, and which frames may be shown (2026-09-05 pivot)
    engine,
    frame_pool: framePool,
    affine_enabled: affineEnabled,
    blink_detour: engine === ENGINE_LEGACY,
    start_point_bias: engine === ENGINE_LEGACY,
    mic_talk:
      engine === ENGINE_LEGACY &&
      (mouthSource === 'mic' || mouthSource === 'hybrid' || mouthSource === 'camera'),
    matcher: matcher as Partial<MatcherOptions> & Record<string, unknown>,
    one_euro_min_cutoff: oneEuroMinCutoff(level, smoothing),
    affine,
    retarget_gain: matcher.retarget_gain as number,
    hold_ms: matcher.hold_ms as number,
    mirror,
    breathing,
    caps: c,
    channels,
    missing_channels: missingChannels,
    warnings,
    ui: { ...LEVELS[level].ui },
  };
}

export interface LevelCard {
  level: string;
  name: string;
  subtitle: string;
  enabled: boolean;
  reason: string;
  warnings: string[];
  channels: string[];
}

/**
 * One card per level for the picker (§2.6): name, subtitle, whether the user may pick
 * it, and — when they may not — the reason, which names the missing thing and the fix.
 * A level that only *degrades* stays selectable and carries its warnings.
 */
export function levelCards(caps?: Partial<MocapCaps> | null): LevelCard[] {
  const c: Partial<MocapCaps> = { ...(caps || {}) };
  if (c.blend === undefined) c.blend = 1;
  const deg = ((c.metrics as Record<string, number> | undefined) || {}).headYawSpanDeg ?? 0;
  const out: LevelCard[] = [];
  for (const key of LEVEL_ORDER) {
    const ui = LEVEL_UI[key];
    const card: LevelCard = {
      level: key,
      name: ui.name,
      subtitle: ui.subtitle,
      enabled: true,
      reason: '',
      warnings: [],
      channels: [],
    };
    if (LEVELS[key].active) {
      const missing = (BLOCKERS[key] || []).filter((k) => !c[k]);
      if (missing.length) {
        card.enabled = false;
        card.reason = fillText(BLOCK_KEY[missing[0]], { deg });
      } else {
        const res = resolveOptions({ level: key }, c);
        card.warnings = res.warnings.map((w) => w.text);
        card.channels = res.channels;
      }
    }
    out.push(card);
  }
  return out;
}

/** Which piece of software picks the frame at this level (`ENGINE_*`). */
export function engineOf(level: string): EngineMode {
  return (LEVELS[level]?.engine ?? ENGINE_MATCHER) as EngineMode;
}

/** This level's default candidate pool (`FRAME_POOL_*`). */
export function framePoolOf(level: string): FramePool {
  return (LEVELS[level]?.frame_pool ?? FRAME_POOL_LEGACY) as FramePool;
}

/** The subset of {@link resolveOptions} that `new MotionMatcher(..., options)` accepts. */
export function matcherKwargs(resolved: ResolvedOptions): Partial<MatcherOptions> {
  return { ...(resolved.matcher || {}) } as Partial<MatcherOptions>;
}

/**
 * Can the user's own mouth reach this level's avatar at all — by any route?
 *
 * True from `presence` up. At `presence` the route is NOT the matcher: the microphone
 * envelope is fed to the player's own lip-sync path (talk range + openness map), which is
 * the thing the user actually liked ("no Ania 1.0 é bonitão"). `expressive` and `mirror`
 * hand the mouth to the matcher instead — see {@link matcherCameraMouth}.
 */
export function allowsCameraMouth(level: string): boolean {
  return level === LEVEL_PRESENCE || level === LEVEL_EXPRESSIVE || level === LEVEL_MIRROR;
}

/**
 * May the MATCHER score the user's mouth (`mouth_policy === "mocap"`)?
 *
 * `presence` never does — its frames come from the legacy cycler, so a hand-edited
 * `mouth_policy: "mocap"` must not half-mirror it (that is the configuration that
 * produced "eu falo mas ela não fala" in the first live session: the level said
 * presence, the advanced key said camera, and the two disagreed about who owned the
 * mouth). `expressive` hands the mouth over after 250 ms of avatar silence, `mirror`
 * whenever the avatar is silent.
 */
export function matcherCameraMouth(level: string): boolean {
  return level === LEVEL_EXPRESSIVE || level === LEVEL_MIRROR;
}

/** Whether the level actually drives the avatar (everything but `off`). */
export function levelActive(level: string): boolean {
  return !!(LEVELS[level in LEVELS ? level : LEVEL_OFF].active);
}

// `groupVector` is re-exported for the ports that build a live mask from a level.
export { groupVector };
