// Animation controller for the Ania avatar.
//
// Drives idle/talk frame cycling plus:
//   - an actions system (play a frame sub-range at a speed/direction, optionally
//     from a random start position, then resume idle/talk)
//   - audio-driven lip-sync: a voicing-gated DSP feeds an envelope, and the
//     envelope modulates the SPEED of a +-1 sweep across the talk range
//
// Framework-free.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED, AND WHY
// ---------------------------------------------------------------------------
// This controller used to do two things wrong, both of which are fixed here.
//
// 1. It paced playback at a hardcoded `1000 / 30` divided by an arbitrary
//    `talkSpeed`. Consumer apps pass values like 5.3, which asks for ~159 fps
//    from footage that was shot at 24. Playback is now derived from the
//    footage's REAL frame rate and held inside a clamp — see
//    `../utils/frame-rate`.
//
// 2. It picked the mouth frame by reading an openness value off the analyser
//    and selecting the talk-range frame whose AUTHORED openness was nearest it.
//    Consecutive rendered frames could be 25 apart: the mouth teleported around
//    the range chasing a number, with no relation to the rhythm of the speech.
//    The desktop player instead sweeps the talk range one frame per tick and
//    lets the envelope shorten the per-frame DELAY — a faster sweep through
//    what is already an open-close mouth cycle is simply a busier mouth. See
//    `../lip-sync/animator`.
//
// The maths lives in `../lip-sync/` and `../utils/frame-rate`, shared with
// `ania-avatar-react`, and is covered by assertions under plain `node`
// (`examples/test-lip-*.mjs`, `examples/test-frame-rate.mjs`).

import { LipSyncDsp } from '../lip-sync/dsp';
import type { LipSyncDspOptions } from '../lip-sync/dsp';
import { LipAnimator, findClosedFrame } from '../lip-sync/animator';
import type { LipAnimatorBranch } from '../lip-sync/animator';
import {
  FPS_FALLBACK,
  FramePacer,
  frameIntervalMs,
  normalizeFpsClamp,
} from '../utils/frame-rate';
import type { FpsClampWindow } from '../utils/frame-rate';
import {
  MatcherError,
  MotionMatcher,
  OneEuroVector,
  LEVEL_OFF,
  ENGINE_LEGACY,
  ENGINE_MATCHER,
  SmoothCut,
  SutilDriver,
  CROSSFADE_MS,
  crossfadeAlpha,
  gainsFromOptions,
  headRegionFromFrame,
  levelActive,
  engineOf,
  paramsForHead,
  paramsFromResidual,
  probeCaps,
  resolveOptions,
  shouldCrossfade,
} from '../motion-matcher';
import type {
  Coverage,
  CrossfadeMode,
  MocapCaps,
  MocapIndex,
  CutBiasFn,
  EngineMode,
  MotionGraph,
  PosesBank,
  SmoothCutOptions,
  StartPointHintFn,
  PoseDescriptorMessage,
  ResolvedOptions,
  WarpRegion,
} from '../motion-matcher';
import type {
  ActionConfig,
  AnimationControllerConfig,
  LipSyncSustainStyle,
  MocapCapabilitiesReport,
  MocapComfortInput,
  MocapConfigureInput,
  MocapCrossfadeState,
  MocapDebugReport,
  MocapWarpState,
} from '../types';

interface ActiveAction {
  config: ActionConfig;
  frame: number;
  direction: number;
  low: number;
  high: number;
  speed: number;
}

/** Extra options for {@link AnimationController.configureLipsSync}. */
export interface LipSyncExtraOptions {
  /** 1..4.5 loud/quiet sweep-speed ratio. Default 2.237. */
  maxSweepBoost?: number;
  /** Overrides for the voicing-gate DSP. */
  dsp?: LipSyncDspOptions;
}

/** ms over which a synthetic articulation pulse decays to nothing. */
const SYNTHETIC_DECAY_MS = 180;

/** Upper bound on a single dt. A backgrounded tab hands us seconds. */
const MAX_DT_MS = 100;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** The per-tick audio reading, as assembled from whichever hooks are wired. */
interface LipsSignals {
  rms: number;
  openness?: number;
}

export class AnimationController {
  private config: AnimationControllerConfig;
  private frameCount: number;
  private currentFrameIndex: number;
  private idleSpeed: number;
  private talkSpeed: number;
  private direction = 1; // 1 = forward, -1 = reverse
  public isTalking = false;

  // ----- Frame pacing -----
  //
  // `idleBaseMs` / `talkBaseMs` are already fps-correct millisecond intervals:
  // `createAniaPlayer` folds the resolved native rate and any speed multiplier
  // into them before construction. The speed sliders below are therefore
  // NEUTRAL (1) on that path, and only move if a host calls setIdleSpeed /
  // setTalkSpeed / setSpeeds later — at which point `getFrameDuration()`
  // re-derives and re-clamps, so a live slider cannot walk back out of the
  // window.
  private idleBaseMs: number;
  private talkBaseMs: number;
  private nativeFps: number;
  private fpsClamp: FpsClampWindow | null;
  private pacer = new FramePacer();

  // ----- Actions -----
  private actions = new Map<string, ActionConfig>();
  private activeAction: ActiveAction | null = null;
  /** Fired when an action starts. */
  public onActionStartCallback: ((id: string) => void) | null = null;
  /** Fired when an action completes naturally (reached the range end). */
  public onActionCompleteCallback: ((id: string) => void) | null = null;
  /** Fired when an action is force-cancelled. */
  public onActionCancelCallback: ((id: string) => void) | null = null;

  // ----- Lip sync -----
  private lipSyncEnabled = false;
  private opennessMap: number[] | null = null;
  private dsp: LipSyncDsp | null = null;
  private animator: LipAnimator | null = null;
  private envelope = 0; // mirror of the animator's envelope, for getLipSyncEnvelope()
  private lipsLastPoll: number | null = null;
  private syntheticValue = 0;
  private syntheticAt = 0;

  /**
   * Instantaneous openness 0..1, supplied by the audio path each frame.
   *
   * Kept as the primary hook for backwards compatibility: when nothing richer
   * is wired, this value drives BOTH the voicing gate and the mouth opening.
   */
  public getOpennessFn: (() => number) | null = null;
  /**
   * RMS of the current audio window, 0..1. Preferred over `getOpennessFn` for
   * the voicing gate — the gate's 0.020 threshold is calibrated in RMS units,
   * and a peak-amplitude reading runs 2-3x the RMS for speech.
   */
  public getRmsFn: (() => number) | null = null;
  /** Peak time-domain amplitude 0..1. Used only if no RMS hook is wired. */
  public getAmplitudeFn: (() => number) | null = null;
  /**
   * A spectral openness estimate 0..1. When present it drives HOW FAR the mouth
   * opens, through its own AGC channel; the gate still keys off the RMS.
   */
  public getSpectralOpennessFn: (() => number) | null = null;

  // ----- Mocap (Ania 2.0 motion matching) -----
  private matcher: MotionMatcher | null = null;
  private mocapEnabled = false;
  private mocapActive = false;
  private mocapMode: string | null = null;
  private mocapDebug: Record<string, number> | null = null;
  private mocapGapMs = 0;
  private mocapGapFired = false;
  /** Fired when the mocap gap EMA (best RMS error) stays above 0.25 for 2s, and
   * again when it recovers. Best-effort UI hook, not covered by parity fixtures. */
  public onMocapGapCallback: ((gapOpen: boolean, emaError: number) => void) | null = null;

  // ----- Reaction levels (Ania 2.0 §2) -----
  private mocapPoses: PosesBank | null = null;
  private mocapGraph: MotionGraph | null = null;
  private mocapCoverage: Coverage | null = null;
  private mocapCaps: MocapCaps | null = null;
  private mocapResolved: ResolvedOptions | null = null;
  private mocapComfort: Partial<MocapComfortInput> = {};
  /** `"full"` is the default the live sessions settled on; `"head"` is opt-in (§2.5). */
  private mocapWarpRegion: WarpRegion = 'full';
  private mocapCanBlend = true;
  private mocapTeleports = 0;
  private mocapLastTransitionCost = 0;
  /** §4.2 crossfade state: the frame being blended out and when the blend started. */
  private mocapFadeFrom = -1;
  private mocapFadeStart = 0;
  private mocapFadeMs = CROSSFADE_MS;

  // ----- §Sutil (2026-09-05 pivot): legacy playback, camera as three hooks -----
  /**
   * Who picks the frame at the level in force. `matcher` runs the Ania 2.0 search every
   * tick; `legacy` leaves Ania 1.0 playback — the cycling, the start positions, the
   * ping-pong turns, the authored transitions — in charge and lets the camera in only
   * through {@link SutilDriver}.
   */
  private mocapEngine: EngineMode = ENGINE_LEGACY;
  private sutil: SutilDriver | null = null;

  // ----- SmoothCut: better cuts, with or without a camera -----
  /**
   * The flagship of Ania 2.0 and the only part of it that runs with the camera off: at
   * every sequence change the entry frame is chosen through the motion graph instead of
   * by index. Inert without a graph, which is what keeps `verify.mjs` frame-identical.
   */
  private smoothCut: SmoothCut | null = null;
  private smoothCutOptions: Partial<SmoothCutOptions> = {};
  private smoothCutRequested: boolean | 'auto' = 'auto';
  /** Bridge frames still to play before the cut's destination is entered. */
  private cutQueue: number[] = [];
  private lastCutCost = 0;
  private lastCutBaseline = 0;
  private lastBridgeFrames = 0;

  /**
   * The one moment an external source may pick a frame without breaking the playback:
   * the start of a cycle, where this controller was about to choose at random.
   * `fn(kind, positions) -> index | null`, `kind` being `'idle' | 'talk' | 'action'`;
   * anything outside `positions` is ignored. `null` — the default — keeps the controller
   * byte-for-byte legacy.
   */
  public startPointHintFn: StartPointHintFn | null = null;

  constructor(config: AnimationControllerConfig, frameCount: number) {
    this.config = config;
    this.frameCount = Math.max(0, Math.floor(num(frameCount, 0)));
    this.currentFrameIndex = config.current_frame_index || 0;

    this.idleSpeed = config.idle_speed_slider_value || 1;
    this.talkSpeed = config.talk_speed_slider_value || 1;

    // What the footage actually IS, and the window playback is held to.
    // Absent (a host constructing the controller directly) => the assumed rate
    // and the default 24-30 fps window, which is still far better than the old
    // hardcoded 30 / arbitrary-multiplier.
    this.nativeFps = num(config.ania_native_fps, FPS_FALLBACK);
    this.fpsClamp =
      config.ania_fps_clamp === undefined
        ? normalizeFpsClamp(undefined)
        : normalizeFpsClamp(config.ania_fps_clamp);

    const nativeMs = 1000 / (this.nativeFps > 0 ? this.nativeFps : FPS_FALLBACK);
    this.idleBaseMs = num(config.idle_frame_duration, nativeMs);
    this.talkBaseMs = num(config.talk_cycle_duration, nativeMs);

    if (this.config.idle_range_low === undefined) this.config.idle_range_low = 0;
    if (this.config.idle_range_high === undefined)
      this.config.idle_range_high = Math.floor(this.frameCount / 2);
    if (this.config.talk_range_low === undefined)
      this.config.talk_range_low = Math.floor(this.frameCount / 2);
    if (this.config.talk_range_high === undefined)
      this.config.talk_range_high = Math.max(0, this.frameCount - 1);

    this.jumpToRandomStartPosition(false);
  }

  // ===== Mode / idle-talk cycling =====

  private jumpToRandomStartPosition(talking: boolean): void {
    const positions = talking
      ? this.config.talk_start_positions
      : this.config.idle_start_positions;
    const range = talking
      ? { low: this.config.talk_range_low!, high: this.config.talk_range_high! }
      : { low: this.config.idle_range_low!, high: this.config.idle_range_high! };

    // This is THE cut of Ania 1.0 — talk->idle, idle->talk, action exit — and the frame it
    // lands on was chosen by index, never by image. `pickStartPosition` runs SmoothCut
    // here; without a graph it hands the legacy choice straight back, so nothing about a
    // graph-less player changes.
    this.currentFrameIndex = this.pickStartPosition(
      talking ? 'talk' : 'idle',
      positions,
      range.low,
      range.low,
      range.high,
    );

    const useReverse = talking
      ? this.config.reverse_talk_selected
      : this.config.reverse_idle_selected;
    this.direction = useReverse ? -1 : 1;
  }

  setTalkingState(talking: boolean): void {
    if (this.isTalking !== talking) {
      this.isTalking = talking;
      // Reset every filter on the idle->talking edge. State left over from the
      // previous utterance — a peak still sitting at 1.0, a sustain counter
      // still latched — makes the first syllable of the next one animate wrong.
      this.dsp?.reset();
      this.animator?.reset();
      this.envelope = 0;
      this.lipsLastPoll = null;
      this.syntheticValue = 0;
      this.syntheticAt = 0;
      // The idle and talk ranges are paced from different intervals, so the
      // accumulator has to re-anchor rather than carry a stale due time over.
      this.pacer.reanchor();
      // Don't reposition mid-action; the action owns the frame cursor.
      if (!this.activeAction) this.jumpToRandomStartPosition(talking);
    }
  }

  // ===== Speed =====

  /**
   * The per-frame interval, in ms, for the current mode.
   *
   * The base is already fps-correct; the speed slider is a multiplier relative
   * to the footage's native rate, and the clamp bounds the result. That is what
   * makes a legacy `talkSpeed={5.3}` a no-op instead of a request for 159 fps.
   */
  getFrameDuration(): number {
    const base = this.isTalking ? this.talkBaseMs : this.idleBaseMs;
    const speed = this.isTalking ? this.talkSpeed : this.idleSpeed;
    return frameIntervalMs({
      nativeFps: base > 0 ? 1000 / base : this.nativeFps,
      speed,
      clamp: this.fpsClamp,
    });
  }

  setSpeeds(idleSpeed?: number, talkSpeed?: number): void {
    if (typeof idleSpeed === 'number' && idleSpeed > 0) this.idleSpeed = idleSpeed;
    if (typeof talkSpeed === 'number' && talkSpeed > 0) this.talkSpeed = talkSpeed;
    this.pacer.reanchor();
  }

  /** Set the idle animation speed multiplier (relative to the native rate). */
  setIdleSpeed(speed: number): void {
    if (speed > 0) this.idleSpeed = speed;
    this.pacer.reanchor();
  }

  /** Set the talk animation speed multiplier (relative to the native rate). */
  setTalkSpeed(speed: number): void {
    if (speed > 0) this.talkSpeed = speed;
    this.pacer.reanchor();
  }

  /** The fps window playback is currently held to, or `null` when unclamped. */
  getFpsClamp(): FpsClampWindow | null {
    return this.fpsClamp;
  }

  /** The footage's resolved frame rate. */
  getNativeFps(): number {
    return this.nativeFps;
  }

  // ===== Actions =====

  /** Register the available actions (replaces any prior set). */
  configureActions(actions: ActionConfig[] | undefined): void {
    this.actions.clear();
    if (!actions) return;
    for (const a of actions) {
      if (a && a.id) this.actions.set(a.id, a);
    }
  }

  getActions(): ActionConfig[] {
    return Array.from(this.actions.values());
  }

  hasAction(id: string): boolean {
    return this.actions.has(id);
  }

  /** Begin playing an action by id. Returns true if the action exists. */
  triggerAction(actionId: string): boolean {
    const config = this.actions.get(actionId);
    if (!config) return false;

    const low = Math.min(config.range_low, config.range_high);
    const high = Math.max(config.range_low, config.range_high);

    let frame = low;
    if (config.start_positions && config.start_positions.length > 0) {
      const idx = Math.floor(Math.random() * config.start_positions.length);
      frame = Math.max(low, Math.min(high, config.start_positions[idx]));
    } else if (config.reverse) {
      frame = high;
    }

    this.activeAction = {
      config,
      frame,
      direction: config.reverse ? -1 : 1,
      low,
      high,
      speed: config.speed && config.speed > 0 ? config.speed : 1,
    };
    this.currentFrameIndex = frame;
    this.pacer.reanchor();
    this.onActionStartCallback?.(actionId);
    return true;
  }

  /**
   * Cancel the active action. With `force`, fires the cancel callback;
   * otherwise it's treated as a natural completion.
   */
  cancelAction(force = false): void {
    if (!this.activeAction) return;
    const id = this.activeAction.config.id;
    this.activeAction = null;
    this.pacer.reanchor();
    this.jumpToRandomStartPosition(this.isTalking);
    if (force) this.onActionCancelCallback?.(id);
    else this.onActionCompleteCallback?.(id);
  }

  isActionPlaying(): boolean {
    return this.activeAction !== null;
  }

  // ===== Lip sync =====

  /**
   * Configure the audio-driven lip-sync. `opennessMap` maps a talk-range frame
   * offset to an openness value 0..1 (built via `buildOpennessMap`).
   *
   * NOTE the 7th parameter. The first six are a POSITIONAL contract with every
   * already-published wrapper (vue / svelte / angular / web-component) and with
   * host apps calling through `AniaPlayerInstance.configureLipsSync`, so they
   * can never be reordered. An optional trailing object is the only safe way to
   * extend it: an old caller omits it and still works.
   *
   * The openness map is now consulted in exactly ONE place — locating the
   * closed-mouth frame during silence. While speech is happening the frame
   * comes from the sweep, not from a lookup.
   */
  configureLipsSync(
    enabled: boolean,
    intensity = 0.6,
    responsiveness = 0.5,
    opennessMap: number[] | null = null,
    sustainStyle: LipSyncSustainStyle = 'wiggle',
    wiggleSpeed = 2,
    options: LipSyncExtraOptions = {}
  ): void {
    const opts = options || {};
    const tuning = {
      intensity: clamp(num(intensity, 0.6), 0, 1),
      responsiveness: clamp(num(responsiveness, 0.5), 0.05, 1),
      sustainStyle: (sustainStyle === 'hold' ? 'hold' : 'wiggle') as LipSyncSustainStyle,
      wiggleSpeed: clamp(num(wiggleSpeed, 2), 1, 6),
      maxSweepBoost: clamp(num(opts.maxSweepBoost, 2.237), 1, 4.5),
    };

    this.lipSyncEnabled = enabled;
    this.opennessMap = opennessMap && opennessMap.length > 0 ? opennessMap : null;

    if (!this.dsp) this.dsp = new LipSyncDsp(opts.dsp || {});
    if (!this.animator) this.animator = new LipAnimator(tuning);
    else this.animator.configure(tuning);

    this.envelope = 0;
    this.lipsLastPoll = null;
    this.syntheticValue = 0;
    this.syntheticAt = 0;
    if (!enabled) {
      this.dsp.reset();
      this.animator.reset();
    }
  }

  isLipSyncEnabled(): boolean {
    return this.lipSyncEnabled;
  }

  getLipSyncEnvelope(): number {
    return this.envelope;
  }

  /** Which frame branch ran last: sustain | silence | voiced. For debug probes. */
  getLipSyncBranch(): LipAnimatorBranch | null {
    return this.animator ? this.animator.lastBranch() : null;
  }

  /**
   * Feed one synthetic articulation pulse.
   *
   * The browser SpeechSynthesis path produces no waveform at all, so there is
   * nothing to analyse. Its `onboundary` event does fire once per word though,
   * and pushing a pulse per word through the SAME envelope and branch machinery
   * gives real per-syllable articulation instead of a binary talk/idle flap.
   * The pulse decays over `SYNTHETIC_DECAY_MS` so it reads as one syllable
   * rather than as a step change.
   */
  pushSyntheticOpenness(value = 1): void {
    this.syntheticValue = clamp(num(value, 1), 0, 1);
    this.syntheticAt = nowMs();
  }

  /**
   * Force the mouth shut immediately.
   *
   * Called when playback is cancelled or the chunk queue is drained. Without it
   * the avatar holds whatever talk frame it was on until the next audio block —
   * which, having been cancelled, never arrives. The desktop hit exactly this
   * and fixed it the same way. It is the one sanctioned jump cut.
   */
  forceLipsClosed(): void {
    this.envelope = 0;
    this.syntheticValue = 0;
    this.syntheticAt = 0;
    this.lipsLastPoll = null;
    this.pacer.reanchor();
    if (!this.animator || !this.dsp) return;
    this.dsp.reset();
    this.animator.reset();

    const { low, high } = this.talkRange();
    if (high > low) {
      const rel = findClosedFrame(
        this.opennessMap,
        this.currentFrameIndex - low,
        this.opennessMap ? this.opennessMap.length : 0
      );
      this.currentFrameIndex = clamp(low + rel, low, high);
    }
  }

  // ===== Mocap (Ania 2.0 motion matching) =====

  /**
   * Load a pose bank (+ optional motion graph, coverage and reaction level) built for
   * this avatar. `null` tears the mocap path down. Returns `false` (and logs) on a
   * `descriptorVersion` mismatch — the caller keeps playing normally.
   *
   * Everything past `poses` is optional and additive: the pre-levels call shape
   * `configureMocap({ poses, motionGraph, options })` still behaves exactly as it did,
   * because a config with no `level` resolves to `off` and leaves `options` in charge.
   */
  configureMocap(index: MocapConfigureInput | null): boolean {
    if (index === null) {
      this.matcher = null;
      this.mocapEnabled = false;
      this.mocapActive = false;
      this.mocapMode = null;
      this.mocapDebug = null;
      this.mocapPoses = null;
      this.mocapGraph = null;
      this.mocapCoverage = null;
      this.mocapCaps = null;
      this.mocapResolved = null;
      this.mocapComfort = {};
      this.mocapTeleports = 0;
      this.mocapLastTransitionCost = 0;
      this.mocapFadeFrom = -1;
      this.mocapEngine = ENGINE_LEGACY;
      this.teardownSutil();
      this.cutQueue = [];
      return true;
    }
    this.mocapPoses = index.poses;
    this.mocapGraph = index.motionGraph ?? null;
    this.mocapCoverage = (index.coverage as Coverage | undefined) ?? null;
    if (index.warpRegion === 'head' || index.warpRegion === 'full') this.mocapWarpRegion = index.warpRegion;
    if (index.canBlend !== undefined) this.mocapCanBlend = !!index.canBlend;
    this.mocapCaps = probeCaps(index.poses, this.mocapCoverage);
    this.mocapCaps.blend = this.mocapCanBlend ? 1 : 0;
    this.mocapComfort = {
      level: index.level ?? LEVEL_OFF,
      intensity: index.intensity,
      smoothing: index.smoothing,
      crossfade: index.crossfade,
      breathing: index.breathing,
      mirror: index.mirror,
      frame_pool: index.framePool,
    };
    if (index.smoothCut !== undefined) this.smoothCutRequested = index.smoothCut;
    this.syncSmoothCut();
    return this.rebuildMatcher(index.options);
  }

  /**
   * Turn on the Ania 2.0 cut work WITHOUT touching the camera.
   *
   * This is the whole feature for a page that only ever plays TTS: hand it the avatar's
   * `motion_graph.json` and every talk->idle, idle->talk, action exit and range wrap
   * stops popping, because the entry frame is chosen through the graph instead of by
   * index. No webcam, no pose bank, no `setMocapEnabled(true)`.
   *
   * `enabled: false` — or simply never calling this — leaves the controller byte-for-byte
   * as it was, which is the regression guard the runtime verifier depends on.
   */
  configureSmoothCut(config: {
    motionGraph?: MotionGraph | null;
    enabled?: boolean | 'auto';
    maxBridge?: number;
    crossfadeMs?: number;
  } | null): boolean {
    if (config === null) {
      this.smoothCut = null;
      this.smoothCutRequested = 'auto';
      this.smoothCutOptions = {};
      this.cutQueue = [];
      return true;
    }
    if (config.motionGraph !== undefined) this.mocapGraph = config.motionGraph;
    if (config.enabled !== undefined) this.smoothCutRequested = config.enabled;
    if (config.maxBridge !== undefined) this.smoothCutOptions.maxBridge = config.maxBridge;
    if (config.crossfadeMs !== undefined) this.smoothCutOptions.crossfadeMs = config.crossfadeMs;
    this.syncSmoothCut();
    // A matcher already standing gives the cut planner the better cost function.
    if (this.matcher) {
      this.smoothCut?.setCostFn((a, b) => (this.matcher ? this.matcher.transitionCost(a, b) : 0));
      this.smoothCut?.setAllowed(this.matcher.allowed);
    }
    return !!this.smoothCut?.active;
  }

  /** Build or drop the cut planner to match the graph and the requested mode. */
  private syncSmoothCut(): void {
    if (this.smoothCutRequested === false || !this.mocapGraph) {
      this.smoothCut = null;
      this.cutQueue = [];
      return;
    }
    this.smoothCut = new SmoothCut(this.mocapGraph, {
      ...this.smoothCutOptions,
      enabled: this.smoothCutRequested,
    });
    this.cutQueue = [];
  }

  /**
   * Enter `[low, high]` on the frame the motion graph says is cheapest to cut to, arming
   * a bridge or a dissolve when even that is a visible jump.
   *
   * Returns the caller's own `fallback` untouched whenever there is no graph — every
   * cut point below calls through here, so that one line is what keeps a graph-less
   * player frame-identical to the one that shipped.
   */
  /**
   * Enter `[low, high]` through the motion graph at a cut that is NOT a cycle start —
   * the two hard range wraps in the cycler, where the last frame of a range is spliced
   * against its first. Returns the frame to show this tick.
   *
   * `from` is the frame the viewer is LOOKING at, which at a wrap is not the cursor: the
   * cycler increments before it notices it has run off the end, so planning from the
   * cursor would score a pair nobody ever sees. `avoid` rules out that frame and its
   * neighbours, because entering on the frame the cycler was about to play anyway costs 0
   * and would win every scan, achieving nothing.
   */
  private planCut(
    low: number,
    high: number,
    starts: number[] | null | undefined,
    fallback: number,
    from: number,
    avoid: number[] | null,
  ): number {
    const shown = this.planCutInto(low, high, starts ? starts.slice() : [], fallback, null, from, avoid, true);
    return shown === null ? fallback : shown;
  }

  /**
   * The frame a cycle starts on: the hint when there is one and it is a real option, the
   * historic random choice otherwise. Mirrors the Python reference's
   * `_pick_start_position`.
   */
  private pickStartPosition(
    kind: string,
    positions: number[] | undefined,
    fallback: number,
    low?: number,
    high?: number,
  ): number {
    const pos = positions ? positions.slice() : [];
    // Exactly ONE draw per cut, always, whichever branch wins below. The legacy player
    // consumed one `Math.random()` here, and a second one would shift every later random
    // start point in the run — a divergence that is invisible in a screenshot and fatal
    // to "no graph => byte-identical", which is the guarantee this feature ships on.
    const choice = pos.length ? pos[Math.floor(Math.random() * pos.length)] : fallback;

    // Order of authority: SmoothCut (cheapest visual entry, with the author's start points
    // as the tie-break and the expression hint as a secondary tie-break inside its
    // near-optimal set) -> the bare hint -> the draw the player has always made.
    const sc = this.smoothCut;
    if (sc && sc.active && low !== undefined && high !== undefined) {
      const fn = this.startPointHintFn;
      const bias: CutBiasFn | null = fn
        ? (cands) => {
            try {
              return fn(kind, cands.slice());
            } catch {
              return null;
            }
          }
        : null;
      const entry = this.planCutInto(low, high, pos, choice, bias, undefined, null, false);
      if (entry !== null) return entry;
    }

    if (!pos.length) return fallback;
    const fn = this.startPointHintFn;
    if (fn) {
      let hint: number | null = null;
      try {
        hint = fn(kind, pos.slice());
      } catch {
        hint = null;
      }
      if (hint !== null && Number.isFinite(hint)) {
        const h = Math.trunc(hint);
        if (pos.indexOf(h) >= 0) return h;
      }
    }
    return choice;
  }

  /**
   * Run SmoothCut for a cycle start and return the frame to SHOW now, or `null` when the
   * planner had no opinion (no graph, nothing rankable) and the caller should keep its
   * own choice. `this.currentFrameIndex` is left on the entry either way, so cycling
   * continues from there once any bridge has drained.
   */
  private planCutInto(
    low: number,
    high: number,
    starts: number[],
    baseline: number,
    bias: CutBiasFn | null,
    from?: number,
    avoid?: number[] | null,
    renderNow = true,
  ): number | null {
    const sc = this.smoothCut;
    if (!sc || !sc.active) return null;
    const src = from === undefined ? this.currentFrameIndex : from;
    const plan = sc.plan(src, low, high, starts, baseline, avoid ?? null, bias);
    if (!plan.planned) return null;
    this.lastCutCost = plan.cost;
    this.lastCutBaseline = plan.baselineCost;
    this.lastBridgeFrames = plan.bridge.length;
    if (plan.crossfade && this.mocapCanBlend) {
      this.mocapFadeFrom = src;
      this.mocapFadeStart = nowMs();
      this.mocapFadeMs = Math.min(sc.opt.crossfadeMs, 3 * this.getFrameDuration());
    }
    // The cursor always ends on the entry, so cycling continues from there. What differs
    // is what reaches the screen first.
    this.currentFrameIndex = plan.frame;
    if (plan.bridge.length) {
      // Play the bridge ahead of the entry, or the viewer sees the entry, then the
      // bridge, then the entry again — planning that is real and smoothing that is
      // imaginary. When the caller is not about to render (a talk<->idle switch), the
      // whole walk goes on the queue instead.
      if (renderNow) {
        this.cutQueue = plan.bridge.slice(1).concat([plan.frame]);
        return plan.bridge[0];
      }
      this.cutQueue = plan.bridge.concat([plan.frame]);
      return plan.frame;
    }
    this.cutQueue = renderNow ? [] : [plan.frame];
    return plan.frame;
  }

  /** Rebuild the matcher from the stored bank + the current comfort object. */
  private rebuildMatcher(extraOptions?: Partial<MocapIndex['options']>): boolean {
    if (!this.mocapPoses) return false;
    const res = resolveOptions(this.mocapComfort as never, this.mocapCaps);
    this.mocapResolved = res;
    // `off` (or a level blocked all the way down to it) leaves the level knobs out
    // entirely, so an explicit `options` object still drives the matcher as before.
    const levelOpts = res.active ? { ...(res.matcher || {}) } : {};
    const options = { ...levelOpts, ...(extraOptions || {}) };
    const oneEuro = res.active && res.one_euro_min_cutoff ? new OneEuroVector(res.one_euro_min_cutoff) : new OneEuroVector();
    try {
      this.matcher = new MotionMatcher(this.mocapPoses, this.mocapGraph, options as never, oneEuro);
      this.wireOpennessMap();
      this.mocapTeleports = 0;
      this.mocapLastTransitionCost = 0;
      this.mocapFadeFrom = -1;
      this.mocapEngine = (res.engine ?? engineOf(res.level)) as EngineMode;
      this.syncSutil(res);
      // the matcher knows where the sequences cut and which frames the pool allows;
      // SmoothCut is strictly better informed with it than without
      this.smoothCut?.setCostFn((a, b) => (this.matcher ? this.matcher.transitionCost(a, b) : 0));
      this.smoothCut?.setAllowed(this.matcher ? this.matcher.allowed : null);
      return true;
    } catch (err) {
      if (err instanceof MatcherError) {
        console.warn('[ania-avatar-core] configureMocap:', err.message);
        this.matcher = null;
        return false;
      }
      throw err;
    }
  }

  /**
   * Switch the reaction level in place (`off | presence | expressive | mirror`).
   * Rebuilds the matcher from the bank already loaded; returns the level actually
   * granted, which is lower than the one asked for when the bank cannot show it.
   */
  setMocapLevel(level: string): string {
    this.mocapComfort = { ...this.mocapComfort, level };
    if (!this.mocapPoses) return LEVEL_OFF;
    this.rebuildMatcher();
    const granted = this.mocapResolved?.level ?? LEVEL_OFF;
    this.setMocapEnabled(levelActive(granted));
    return granted;
  }

  /** Update one or more comfort keys (§3) without changing the level. */
  setMocapComfort(comfort: Partial<MocapComfortInput>): ResolvedOptions | null {
    this.mocapComfort = { ...this.mocapComfort, ...comfort };
    if (this.mocapPoses) this.rebuildMatcher();
    return this.mocapResolved;
  }

  /**
   * Where the user's mouth-OPEN value comes from: `audio | camera | mic | hybrid`.
   * `presence` always keeps `audio` whatever is asked for. Returns the source granted.
   */
  setMouthSource(source: string): string {
    this.mocapComfort = { ...this.mocapComfort, mouth_source: source as MocapComfortInput['mouth_source'] };
    if (this.mocapPoses) this.rebuildMatcher();
    return this.mocapResolved?.mouth_source ?? 'audio';
  }

  /**
   * Push the USER's microphone envelope (0..1) for the `mic`/`hybrid` mouth sources.
   * `null` says there is no mic, which drops the matcher back to the camera's MAR. The
   * envelope itself is measured capture-side; the matcher only consumes it.
   */
  pushMicOpenness(value: number | null, atMs?: number): void {
    this.matcher?.setMicOpenness(value, atMs ?? nowMs());
  }

  /** Tear the §Sutil driver down and unhook everything it installed. */
  private teardownSutil(): void {
    this.sutil?.detach();
    this.sutil = null;
  }

  /**
   * Stand the §Sutil driver up for a legacy-engine level, or tear it down for anything
   * else. Called on every matcher rebuild, so a level change swaps engines cleanly.
   */
  private syncSutil(res: ResolvedOptions | null): void {
    const wants = !!res?.active && (res.engine ?? ENGINE_MATCHER) === ENGINE_LEGACY && !!this.matcher;
    this.teardownSutil();
    if (!wants) return;
    this.sutil = new SutilDriver(this as never, this.matcher as never, {
      blinkDetour: res!.blink_detour !== false,
      startPointBias: res!.start_point_bias !== false,
      micTalk: res!.mic_talk !== false,
    });
    this.sutil.attach();
  }

  /** Whether the level in force wants a microphone envelope pushed into it. */
  mocapNeedsMic(): boolean {
    return !!this.mocapResolved?.needs_mic;
  }

  /**
   * Hand the legacy lip-sync openness map to the ARTICULATE search, so the camera path
   * picks the same mouths the audio path would.
   */
  private wireOpennessMap(): void {
    if (!this.matcher || !this.opennessMap) return;
    this.matcher.setOpennessMap(this.opennessMap, this.talkRange().low);
  }

  /**
   * What this bank can physically show, plus the pt-BR warnings for the level in
   * force. `caps` are the §5.1 0/1 flags + a `metrics` block; `warnings` carry both
   * the i18n key and the ready-made sentence.
   */
  getMocapCapabilities(): MocapCapabilitiesReport {
    const res = this.mocapResolved;
    return {
      caps: this.mocapCaps ?? probeCaps(null),
      level: res?.level ?? LEVEL_OFF,
      requestedLevel: res?.requested_level ?? (this.mocapComfort.level ?? LEVEL_OFF),
      blocked: !!res?.blocked,
      active: !!res?.active,
      canBlend: this.mocapCanBlend,
      crossfade: (res?.crossfade ?? 'auto') as CrossfadeMode,
      channels: res?.channels ?? [],
      missingChannels: res?.missing_channels ?? [],
      warnings: (res?.warnings ?? []).map((w) => ({ key: w.key, text: w.text })),
      comfort: res?.comfort ? ({ ...res.comfort } as Record<string, unknown>) : null,
    };
  }

  /** The resolved option table for the level in force (matcher knobs, affine caps). */
  getMocapOptions(): ResolvedOptions | null {
    return this.mocapResolved;
  }

  /** Feed one live pose sample (from a webcam/mocap capture source). */
  pushPose(desc: PoseDescriptorMessage): void {
    this.matcher?.pushPose(desc.t, desc.mask, desc.d, desc.norm ?? 'raw');
  }

  setMocapEnabled(enabled: boolean): void {
    this.mocapEnabled = enabled;
    if (!enabled) this.mocapActive = false;
  }

  /** Whether the mocap branch drove the last rendered frame. */
  isMocapActive(): boolean {
    return this.mocapActive;
  }

  getMocapMode(): string | null {
    return this.mocapMode;
  }

  /**
   * HUD/debug snapshot. Carries the numeric matcher counters plus the four fields the
   * levels UI shows: the granted `level`, whether the mouth is on `audio` or `camera`
   * right now, the visual cost of the last transition, and the teleport count.
   */
  getMocapDebug(): MocapDebugReport | null {
    // SmoothCut runs with the camera off and no pose bank, so a page that only ever
    // called `configureSmoothCut` still has cut numbers worth reading. Returning `null`
    // there would hide the one feature that works without mocap at all.
    if (!this.mocapDebug && !this.smoothCut?.active) return null;
    return {
      ...(this.mocapDebug || {}),
      level: this.mocapResolved?.level ?? LEVEL_OFF,
      mouthSource: this.matcher ? this.matcher.mouthSource : 'audio',
      lastTransitionCost: this.mocapLastTransitionCost,
      teleports: this.mocapTeleports,
      breathing: this.matcher ? this.matcher.breathingActive : false,
      blinks: this.matcher ? this.matcher.blinkEvents : 0,
      articulating: this.matcher ? this.matcher.articulating : false,
      mouthSourceMode: this.mocapResolved?.mouth_source ?? 'audio',
      warpRegion: this.mocapWarpRegion,
      engine: this.mocapEngine,
      framePool: this.mocapResolved?.frame_pool ?? 'legacy',
      lastCutCost: this.lastCutCost,
      lastCutBaseline: this.lastCutBaseline,
      bridgeFrames: this.lastBridgeFrames,
    };
  }

  /** Live target minus the currently rendered frame's descriptor (affine warp input). */
  getMocapResidual(): number[] | null {
    return this.matcher ? Array.from(this.matcher.residual(this.currentFrameIndex)) : null;
  }

  /**
   * Everything the renderer needs for one tick: the affine params for the residual
   * warp, the head ellipse to composite them through (or `null` for a whole-frame
   * warp), and the crossfade state when the matcher just took a visible jump.
   *
   * Returns `null` while the mocap branch is not driving the avatar, in which case
   * the renderer draws the frame exactly as it always did — which is what keeps
   * `verify.mjs` frame-identical with mocap off.
   */
  getMocapWarp(width: number, height: number, nowMs: number): MocapWarpState | null {
    if (!this.matcher || !this.mocapActive || !this.mocapResolved?.active) return null;
    // A warped head on top of a legacy-played sequence is exactly the "sticker" the live
    // test rejected, so `presence` computes no warp at all.
    if (this.mocapEngine === ENGINE_LEGACY || this.mocapResolved.affine_enabled === false) return null;
    const res = this.mocapResolved;
    const gains = gainsFromOptions(res.affine);
    const breathingT = this.matcher.breathingActive ? (this.mocapDebug?.tick ?? 0) * 0.04 : null;
    let params = paramsFromResidual(
      this.matcher.residual(this.currentFrameIndex),
      width,
      height,
      gains,
      res.affine?.strength ?? 1.0,
      breathingT,
    );
    const region =
      this.mocapWarpRegion === 'head'
        ? headRegionFromFrame(this.matcher.frameDescriptor(this.currentFrameIndex), 0xff)
        : null;
    // Head-only mode re-aims the transform: pivot at the neck base, scale pinned to 1,
    // and the far tighter head caps — or the head slides off the shoulders.
    if (region) params = paramsForHead(params, region, width, height, gains);
    let fade: MocapCrossfadeState | null = null;
    if (this.mocapFadeFrom >= 0) {
      const elapsed = nowMs - this.mocapFadeStart;
      if (elapsed >= this.mocapFadeMs) {
        this.mocapFadeFrom = -1;
      } else {
        fade = { fromFrame: this.mocapFadeFrom, alpha: crossfadeAlpha(elapsed, this.mocapFadeMs) };
      }
    }
    return { params, region, crossfade: fade, warpRegion: this.mocapWarpRegion };
  }

  /** The talk range, floored and bounded by the real frame count. */
  private talkRange(): { low: number; high: number } {
    const low = Math.floor(num(this.config.talk_range_low, 0));
    const declaredHigh = Math.floor(num(this.config.talk_range_high, this.frameCount - 1));
    const high = this.frameCount > 0 ? Math.min(declaredHigh, this.frameCount - 1) : declaredHigh;
    return { low, high };
  }

  /**
   * The raw signals for this tick, as `{rms, openness}`.
   *
   * Returns null ONLY when no audio source is wired at all. A source that is
   * present but silent must report 0, never null: the silence branch depends on
   * being FED zeros. Returning null there was the old behaviour, and it fell
   * through to the blind frame cycler — which is precisely why the mouth kept
   * flapping after the audio had already stopped.
   */
  private lipsSignals(now: number): LipsSignals | null {
    let rms: number | null = null;
    let openness: number | null = null;
    if (this.getRmsFn) rms = this.getRmsFn();
    if (this.getSpectralOpennessFn) openness = this.getSpectralOpennessFn();
    if (rms == null && this.getAmplitudeFn) rms = this.getAmplitudeFn();
    if (rms == null && this.getOpennessFn) rms = this.getOpennessFn();
    if (rms == null && openness != null) rms = openness;

    if (rms == null) {
      // No analyser wired. Fall back to the synthetic pulse train, which is the
      // browser-TTS path.
      if (this.syntheticAt) {
        const age = now - this.syntheticAt;
        if (age >= 0 && age < SYNTHETIC_DECAY_MS) {
          const decayed = this.syntheticValue * (1 - age / SYNTHETIC_DECAY_MS);
          return { rms: decayed, openness: decayed };
        }
        return { rms: 0, openness: 0 };
      }
      return null;
    }
    return {
      rms: typeof rms === 'number' && Number.isFinite(rms) ? clamp(rms, 0, 1) : 0,
      openness:
        typeof openness === 'number' && Number.isFinite(openness)
          ? clamp(openness, 0, 1)
          : undefined,
    };
  }

  // ===== Per-frame tick =====

  /**
   * Advance the animation. Returns the frame index to render, or -1 if it's
   * not yet time to update. Call from a rAF loop with the timestamp.
   *
   * The DSP and the envelope advance on EVERY call, independent of whether a
   * frame is due. That is what keeps the envelope fresh at the instant the
   * frame gate opens: gating the analysis at the frame rate as well would alias
   * the audio against the animation and reintroduce exactly the drift this
   * rewrite exists to remove.
   */
  getNextFrame(timestamp: number): number {
    const now = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : nowMs();

    // A hidden tab stops issuing rAF callbacks, so the first dt after it comes
    // back would be however long the user was away. Freeze instead, and drop
    // the timestamp so the next poll starts from zero rather than decaying
    // every filter to its floor in a single step.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.lipsLastPoll = null;
      this.pacer.reanchor(); // re-anchor on return, no catch-up burst
      return -1;
    }

    const dt = this.lipsLastPoll === null ? 0 : Math.min(MAX_DT_MS, now - this.lipsLastPoll);
    this.lipsLastPoll = now;

    // Pacing is only engaged when a clamp is in force. A host that opted out
    // with `fpsClamp: false` keeps the original "reset to now" gate.
    const paced = this.fpsClamp !== null;

    // The matcher's audio prior has to stay in sync with the mouth every tick,
    // independent of which branch below actually renders the frame — sound
    // keeps flowing while e.g. an action plays.
    if (this.matcher) this.matcher.setAudio(this.isTalking, this.envelope);

    // --- Active action takes priority ---
    if (this.activeAction) {
      const a = this.activeAction;
      // Studio files carry an fps-correct idle interval; the per-action speed
      // scales it, mirroring the desktop's action player.
      const interval = this.idleBaseMs / a.speed;
      if (!this.pacer.advanceDue(now, interval, paced)) return -1;

      a.frame += a.direction;
      if (a.frame > a.high || a.frame < a.low) {
        this.cancelAction(false);
        return Math.floor(this.currentFrameIndex);
      }
      this.currentFrameIndex = a.frame;
      return Math.floor(a.frame);
    }

    // --- SmoothCut bridge: the frames that carry the avatar into the cut ---
    // A bridge is the avatar's own footage played on the way in, so it reads as motion
    // rather than as a dissolve. `currentFrameIndex` already sits on the destination —
    // the queue only decides what the viewer sees on the way there.
    if (this.cutQueue.length) {
      if (!this.pacer.advanceDue(now, this.getFrameDuration(), paced)) return -1;
      return Math.floor(this.cutQueue.shift() as number);
    }

    // --- Sutil: Ania 1.0 playback, camera and mic as three narrow hooks ---
    // The driver answers `null` on almost every tick, which is the documented "legacy
    // runs this tick"; the only frame it ever forces is the two-tick blink detour.
    // Gated on the DRIVER existing, not on `mocapEngine`, and that distinction is load
    // bearing: `resolveOptions` reports `engine: 'legacy'` for level `off` too, so gating
    // on the constant would swallow the matcher branch for the pre-levels call shape
    // (`configureMocap({ poses, motionGraph, options })` + `setMocapEnabled(true)`, which
    // is every already-deployed host) — the matcher would be built and never stepped.
    // `syncSutil` only stands a driver up for an ACTIVE legacy-engine level, which is
    // exactly the condition Python gates on (`plugin.py`: `if self._sutil is not None`).
    if (this.mocapEnabled && this.matcher && this.sutil) {
      {
        const forced = this.sutil.onTick(
          now,
          this.currentFrameIndex,
          this.matcher.micOpennessAt_(now, this.matcher.opt.stale_ms),
          this.isTalking && !(this.sutil.mic?.owner ?? false),
        );
        if (forced !== null) {
          if (!this.pacer.advanceDue(now, this.getFrameDuration(), paced)) return -1;
          this.mocapActive = true;
          this.currentFrameIndex = forced;
          return Math.floor(forced);
        }
      }
      this.mocapActive = false;
      // fall through to the legacy branches below — that is the whole point of Sutil
    } else if (this.mocapEnabled && this.matcher) {
      const fresh = this.matcher.hasFreshPose(now);
      if (fresh || this.mocapActive) {
        if (!this.pacer.advanceDue(now, this.getFrameDuration(), paced)) return -1;

        const prevFrame = this.currentFrameIndex;
        const r = this.matcher.step(now, this.currentFrameIndex);
        this.currentFrameIndex = r.frame;
        this.mocapMode = r.mode;
        this.mocapDebug = r.debug;
        this.mocapLastTransitionCost = r.transition_cost;
        if (r.teleport) this.mocapTeleports += 1;
        // §4.2: a transition this expensive is a visible jump. Arm the alpha blend so
        // the renderer crossfades the previous frame out over <= 120 ms.
        if (
          r.frame !== prevFrame &&
          shouldCrossfade(r.transition_cost, this.mocapResolved?.crossfade ?? 'auto', this.mocapCanBlend)
        ) {
          this.mocapFadeFrom = prevFrame;
          this.mocapFadeStart = now;
          this.mocapFadeMs = Math.min(CROSSFADE_MS, 3 * this.getFrameDuration());
        }

        const emaE = r.debug.ema_E;
        if (emaE > 0.25) {
          this.mocapGapMs += dt;
          if (this.mocapGapMs >= 2000 && !this.mocapGapFired) {
            this.mocapGapFired = true;
            this.onMocapGapCallback?.(true, emaE);
          }
        } else {
          this.mocapGapMs = 0;
          if (this.mocapGapFired) {
            this.mocapGapFired = false;
            this.onMocapGapCallback?.(false, emaE);
          }
        }

        // `handoff`: the matcher has been parked on the idle range long enough
        // that the legacy cycler should take back over. It resumes from
        // `currentFrameIndex` as-is below — no `jumpToRandomStartPosition` — so
        // the frame the matcher settled on is exactly where cycling continues.
        this.mocapActive = !r.handoff;
        return Math.floor(this.currentFrameIndex);
      }
      this.mocapActive = false;
    }

    // --- Audio-driven lip-sync (only while talking, needs an audio hook) ---
    if (this.lipSyncEnabled && this.isTalking && this.animator && this.dsp) {
      const sig = this.lipsSignals(now);
      if (sig) {
        const r = this.dsp.poll(dt, sig.rms, sig.openness);
        this.animator.poll(dt, r.gateOpen ? r.openness : 0);
        this.envelope = this.animator.getEnvelope();

        // The base interval is already fps-clamped; the envelope modulates
        // WITHIN a bounded multiplier above it, so a loud passage sweeps up to
        // maxSweepBoost times faster without escaping the clamp altogether.
        const talkBase = this.getFrameDuration() * this.animator.intervalScale();
        if (!this.pacer.advanceDue(now, talkBase, paced)) return -1;

        const { low, high } = this.talkRange();
        this.currentFrameIndex = this.animator.step({
          currentFrame: this.currentFrameIndex,
          talkLow: low,
          talkHigh: high,
          opennessMap: this.opennessMap,
        });
        return Math.floor(this.currentFrameIndex);
      }
    }

    // --- Standard idle/talk cycling ---
    if (!this.pacer.advanceDue(now, this.getFrameDuration(), paced)) return -1;

    const range = this.isTalking
      ? { low: this.config.talk_range_low!, high: this.config.talk_range_high! }
      : { low: this.config.idle_range_low!, high: this.config.idle_range_high! };

    // The frame still on screen — the one a cut would be seen against.
    const shown = this.currentFrameIndex;
    // Set by a planned cut when the frame to show now is not the cursor (a bridge).
    let renderFrame: number | null = null;
    this.currentFrameIndex += this.direction;

    const starts = this.isTalking ? this.config.talk_start_positions : this.config.idle_start_positions;
    if (this.currentFrameIndex >= range.high) {
      if (this.config.reverse_idle_selected || this.config.reverse_talk_selected) {
        // A ping-pong turn is not a cut: `high - 1` is the frame the footage was already
        // on. Re-choosing it through the graph would MANUFACTURE a jump, so it is left
        // exactly as it was.
        this.direction = -1;
        this.currentFrameIndex = range.high - 1;
      } else {
        // A wrap IS a cut — the last frame of the range against its first, two images
        // with nothing in common. This is the second place Ania 1.0 pops.
        renderFrame = this.planCut(range.low, range.high, starts, range.low, shown, [
          shown - 1,
          shown,
          shown + 1,
        ]);
      }
    } else if (this.currentFrameIndex < range.low) {
      if (this.config.reverse_idle_selected || this.config.reverse_talk_selected) {
        this.direction = 1;
        this.currentFrameIndex = range.low + 1;
      } else {
        renderFrame = this.planCut(range.low, range.high, starts, range.high - 1, shown, [
          shown - 1,
          shown,
          shown + 1,
        ]);
      }
    }

    return Math.floor(renderFrame === null ? this.currentFrameIndex : renderFrame);
  }
}
