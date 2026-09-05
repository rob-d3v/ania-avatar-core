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
import { MatcherError, MotionMatcher, OneEuroVector } from '../motion-matcher';
import type { MocapIndex, PoseDescriptorMessage } from '../motion-matcher';
import type {
  ActionConfig,
  AnimationControllerConfig,
  LipSyncSustainStyle,
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

    if (positions && positions.length > 0) {
      const randomIndex = Math.floor(Math.random() * positions.length);
      this.currentFrameIndex = positions[randomIndex];
    } else {
      const range = talking
        ? { low: this.config.talk_range_low!, high: this.config.talk_range_high! }
        : { low: this.config.idle_range_low!, high: this.config.idle_range_high! };
      this.currentFrameIndex = range.low;
    }

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
   * Load a pose bank (+ optional motion graph) built for this avatar.
   * `null` tears the mocap path down. Returns `false` (and logs) on a
   * `descriptorVersion` mismatch — the caller keeps playing normally.
   */
  configureMocap(index: MocapIndex | null): boolean {
    if (index === null) {
      this.matcher = null;
      this.mocapEnabled = false;
      this.mocapActive = false;
      this.mocapMode = null;
      this.mocapDebug = null;
      return true;
    }
    try {
      this.matcher = new MotionMatcher(index.poses, index.motionGraph ?? null, index.options, new OneEuroVector());
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

  getMocapDebug(): Record<string, number> | null {
    return this.mocapDebug;
  }

  /** Live target minus the currently rendered frame's descriptor (affine warp input). */
  getMocapResidual(): number[] | null {
    return this.matcher ? Array.from(this.matcher.residual(this.currentFrameIndex)) : null;
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

    // --- Mocap (motion matching against a live pose stream) ---
    if (this.mocapEnabled && this.matcher) {
      const fresh = this.matcher.hasFreshPose(now);
      if (fresh || this.mocapActive) {
        if (!this.pacer.advanceDue(now, this.getFrameDuration(), paced)) return -1;

        const r = this.matcher.step(now, this.currentFrameIndex);
        this.currentFrameIndex = r.frame;
        this.mocapMode = r.mode;
        this.mocapDebug = r.debug;

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

    this.currentFrameIndex += this.direction;

    if (this.currentFrameIndex >= range.high) {
      if (this.config.reverse_idle_selected || this.config.reverse_talk_selected) {
        this.direction = -1;
        this.currentFrameIndex = range.high - 1;
      } else {
        this.currentFrameIndex = range.low;
      }
    } else if (this.currentFrameIndex < range.low) {
      if (this.config.reverse_idle_selected || this.config.reverse_talk_selected) {
        this.direction = 1;
        this.currentFrameIndex = range.low + 1;
      } else {
        this.currentFrameIndex = range.high - 1;
      }
    }

    return Math.floor(this.currentFrameIndex);
  }
}
