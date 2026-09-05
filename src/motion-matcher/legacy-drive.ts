/**
 * The `presence` ("Sutil") engine — the legacy player keeps playing, the camera only
 * nudges it. 1:1 port of
 * `AniaAPP/src/ania_player/plugins/mocap_webcam/legacy_drive.py`.
 *
 * Why this module exists, in the user's own words after the second live test:
 *
 *     "é a transição... no Ania 1.0 é bonitão... ela nem tá falando quando eu falo"
 *
 * Frame-by-frame motion matching at 25 Hz replaces the player's hand-authored playback —
 * ping-pong through a sequence, a random start point per cycle, the openness map — with a
 * per-tick nearest-neighbour search. Every individual frame is defensible and the *motion*
 * is not, because the transitions are the product. No teleport gate fixes that: the cure
 * is to stop choosing frames.
 *
 * So `Sutil` inverts the responsibility:
 *
 * - `AnimationController` keeps the cursor. `SutilDriver.onTick` returns `null` on almost
 *   every tick, which is the documented "legacy runs this tick" answer.
 * - The user's **microphone** drives the player's own lip-sync path — the same
 *   `setTalkingState` + amplitude getters a TTS engine uses. Speaking user -> the avatar
 *   enters its talk sequence and articulates with its openness map; silence -> back to
 *   idle the legacy way. The avatar's own audio always wins.
 * - A **blink** is a two-tick detour to an eye-closed frame *inside the current
 *   sequence*, handed back at the same position. Neighbouring frames of one sequence
 *   differ by a blink and little else, so nothing reads as a cut.
 * - **Smile / head yaw** only bias the frame the cycler picks *at a cut point* — the
 *   random start position it was about to choose anyway. Never mid-sequence.
 *
 * Everything here is duck-typed against the controller and the matcher, so the tests
 * drive the very same code the player runs.
 */

import {
  BLINK_DETOUR_MAX_DELTA,
  BLINK_DETOUR_TICKS,
  MIC_TALK_CLOSE_TICKS,
  MIC_TALK_OPEN_TICKS,
  MIC_TALK_THRESHOLD,
} from './levels';

/** The slice of `AnimationController` this module needs. Duck-typed on purpose. */
export interface LegacyHost {
  setTalkingState(talking: boolean): void;
  getAmplitudeFn: (() => number) | null;
  getRmsFn: (() => number) | null;
  getSpectralOpennessFn: (() => number) | null;
  getOpennessFn: (() => number) | null;
  currentFrameIndex: number;
  startPointHintFn: StartPointHintFn | null;
}

/** The one moment an external source may pick a frame: the start of a cycle. */
export type StartPointHintFn = (kind: string, positions: number[]) => number | null;

/** The slice of `MotionMatcher` this module needs. */
export interface LegacyMatcher {
  blinkEdge(nowMs: number): boolean;
  blinkFrameNear(i: number, maxDelta?: number): number | null;
  startPointScore(candidates: ArrayLike<number> | null | undefined): number | null;
}

// --------------------------------------------------------------------- mic -> talk
/**
 * User microphone envelope -> the player's existing lip-sync path.
 *
 * A threshold + frame-counter state machine toggles `setTalkingState`, and the
 * controller's amplitude getters are redirected to the mic envelope while the bridge owns
 * the mouth, so the talk branch articulates from the user's voice exactly as it does from
 * a TTS waveform. The avatar's own audio takes the mouth straight back.
 *
 * Nothing is recorded and nothing is sent: what crosses this class is one float per tick.
 */
export class MicTalkBridge {
  private saved: Partial<Record<string, (() => number) | null>> = {};
  private hijacked = false;
  public level = 0.0;
  /** Are WE the reason the avatar is talking? */
  public owner = false;
  public talkTicks = 0;
  public silenceTicks = 0;
  public talkTicksTotal = 0;
  public ticks = 0;

  constructor(
    private host: LegacyHost | null,
    public threshold = MIC_TALK_THRESHOLD,
    public openTicks = MIC_TALK_OPEN_TICKS,
    public closeTicks = MIC_TALK_CLOSE_TICKS,
  ) {
    this.openTicks = Math.max(0, Math.trunc(openTicks));
    this.closeTicks = Math.max(1, Math.trunc(closeTicks));
  }

  /**
   * Redirect the lip-sync getters at our envelope. Idempotent; the originals are restored
   * by `detach` and are delegated to whenever we do not own the mouth, so a TTS bridge
   * that grabs them later still wins.
   */
  attach(): void {
    const host = this.host;
    if (!host || this.hijacked) return;
    for (const name of ['getAmplitudeFn', 'getRmsFn', 'getSpectralOpennessFn', 'getOpennessFn'] as const) {
      this.saved[name] = host[name];
    }
    const delegate = (name: string): number => {
      const prev = this.saved[name];
      return prev ? Number(prev()) || 0 : 0;
    };
    host.getAmplitudeFn = () => (this.owner ? this.level : delegate('getAmplitudeFn'));
    host.getRmsFn = () => (this.owner ? this.level : delegate('getRmsFn'));
    host.getSpectralOpennessFn = () => (this.owner ? this.level : delegate('getSpectralOpennessFn'));
    host.getOpennessFn = () => (this.owner ? this.level : delegate('getOpennessFn'));
    this.hijacked = true;
  }

  detach(): void {
    const host = this.host;
    if (!host || !this.hijacked) return;
    this.release();
    for (const name of ['getAmplitudeFn', 'getRmsFn', 'getSpectralOpennessFn', 'getOpennessFn'] as const) {
      host[name] = (this.saved[name] ?? null) as (() => number) | null;
    }
    this.saved = {};
    this.hijacked = false;
  }

  /**
   * One tick. `openness` is 0..1 from the mic (or the camera fallback), `null` when there
   * is no source. Returns whether the user is driving the talk.
   */
  push(openness: number | null | undefined, avatarTalking: boolean): boolean {
    this.ticks += 1;
    if (avatarTalking) {
      // Rule 1: the avatar's own voice owns the mouth, always.
      this.level = 0.0;
      this.talkTicks = 0;
      this.silenceTicks = 0;
      if (this.owner) {
        // Hand the getters back; do NOT touch setTalkingState — the audio controller
        // already owns that flag.
        this.owner = false;
      }
      return false;
    }
    let v = openness === null || openness === undefined ? 0.0 : Number(openness);
    if (!Number.isFinite(v) || v < 0.0) v = 0.0;
    this.level = Math.min(1.0, v);
    if (this.level > this.threshold) {
      this.silenceTicks = 0;
      this.talkTicks += 1;
      if (!this.owner && this.talkTicks > this.openTicks) this.setTalking(true);
    } else {
      this.talkTicks = 0;
      this.silenceTicks += 1;
      if (this.owner && this.silenceTicks > this.closeTicks) {
        this.level = 0.0;
        this.setTalking(false);
      }
    }
    if (this.owner) this.talkTicksTotal += 1;
    return this.owner;
  }

  /** Give the mouth back (plugin stop, level change, avatar swap). */
  release(): void {
    if (this.owner) this.setTalking(false);
  }

  private setTalking(talking: boolean): void {
    this.owner = !!talking;
    try {
      this.host?.setTalkingState(!!talking);
    } catch {
      /* a host that cannot switch state must not stop the animation */
    }
  }

  /** Share of ticks the user owned the talk — the acceptance metric. */
  get talkPct(): number {
    return this.ticks ? (100.0 * this.talkTicksTotal) / this.ticks : 0.0;
  }
}

// --------------------------------------------------------------------- blink detour
/**
 * Two ticks on an eye-closed frame of the current sequence, then back home.
 *
 * The detour never changes where the cycler *is*: `home` is the frame the legacy engine
 * had, and it is written straight back when the detour ends, so the sequence resumes from
 * the same place. State only; the caller owns the frame.
 */
export class BlinkDetour {
  public remaining = 0;
  public home: number | null = null;
  public frame: number | null = null;
  public detours = 0;
  public misses = 0;

  constructor(
    public holdTicks = BLINK_DETOUR_TICKS,
    public maxDelta = BLINK_DETOUR_MAX_DELTA,
  ) {
    this.holdTicks = Math.max(1, Math.trunc(holdTicks));
    this.maxDelta = Math.max(0, Math.trunc(maxDelta));
  }

  reset(): void {
    this.remaining = 0;
    this.home = null;
    this.frame = null;
  }

  /**
   * `[frame to force, frame to hand back]` for this tick.
   *
   * - mid-detour -> `[blink frame, null]`
   * - last tick  -> `[null, home]`: the caller restores the cursor and lets legacy run
   * - blink edge -> `[blink frame, null]` if one is close enough, else `[null, null]`
   * - otherwise  -> `[null, null]`
   */
  tick(currentFrame: number, edge: boolean, pick: (i: number) => number | null): [number | null, number | null] {
    if (this.remaining > 0) {
      this.remaining -= 1;
      if (this.remaining > 0) return [this.frame, null];
      const home = this.home;
      this.home = null;
      this.frame = null;
      return [null, home];
    }
    if (!edge) return [null, null];
    const j = pick(Math.trunc(currentFrame));
    if (j === null) {
      this.misses += 1;
      return [null, null];
    }
    this.home = Math.trunc(currentFrame);
    this.frame = Math.trunc(j);
    this.remaining = this.holdTicks - 1;
    this.detours += 1;
    if (this.remaining <= 0) {
      // a one-tick detour still has to hand back
      const home = this.home;
      this.home = null;
      this.frame = null;
      return [Math.trunc(j), home];
    }
    return [Math.trunc(j), null];
  }
}

// --------------------------------------------------------------------- the engine
export interface SutilOptions {
  blinkDetour: boolean;
  blinkHoldTicks: number;
  blinkMaxDelta: number;
  startPointBias: boolean;
  micTalk: boolean;
  micTalkThreshold: number;
  micTalkCloseTicks: number;
}

export const DEFAULT_SUTIL_OPTIONS: SutilOptions = {
  blinkDetour: true,
  blinkHoldTicks: BLINK_DETOUR_TICKS,
  blinkMaxDelta: BLINK_DETOUR_MAX_DELTA,
  startPointBias: true,
  micTalk: true,
  micTalkThreshold: MIC_TALK_THRESHOLD,
  micTalkCloseTicks: MIC_TALK_CLOSE_TICKS,
};

/**
 * `presence` end to end: attach to a controller + a matcher, call `onTick` from the
 * controller's mocap branch, and the legacy engine does the rest.
 *
 * `onTick` returns `null` to let the legacy branch run this tick, or the frame index to
 * force for the blink detour. It is the ONLY thing this level ever forces.
 */
export class SutilDriver {
  public readonly mic: MicTalkBridge | null;
  public readonly detour: BlinkDetour;
  private savedHint: StartPointHintFn | null = null;
  private attached = false;
  public ticks = 0;
  public forcedTicks = 0;
  public hints = 0;
  public readonly opt: SutilOptions;

  constructor(
    private host: LegacyHost | null,
    private matcher: LegacyMatcher | null,
    options?: Partial<SutilOptions>,
  ) {
    this.opt = { ...DEFAULT_SUTIL_OPTIONS, ...(options || {}) };
    this.mic = this.opt.micTalk
      ? new MicTalkBridge(host, this.opt.micTalkThreshold, MIC_TALK_OPEN_TICKS, this.opt.micTalkCloseTicks)
      : null;
    this.detour = new BlinkDetour(this.opt.blinkHoldTicks, this.opt.blinkMaxDelta);
    this.startPointHint = this.startPointHint.bind(this);
  }

  attach(): void {
    if (this.attached) return;
    this.mic?.attach();
    if (this.opt.startPointBias && this.host) {
      this.savedHint = this.host.startPointHintFn;
      this.host.startPointHintFn = this.startPointHint;
    }
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.mic?.detach();
    if (this.host && this.host.startPointHintFn === this.startPointHint) {
      this.host.startPointHintFn = this.savedHint;
    }
    this.savedHint = null;
    this.detour.reset();
    this.attached = false;
  }

  /**
   * The one moment the camera may pick a frame: the cycler is starting a cycle and was
   * about to choose at random. Bias it toward the user's smile and yaw.
   */
  startPointHint(_kind: string, positions: number[]): number | null {
    const m = this.matcher;
    if (!m || !positions || !positions.length) return null;
    let j: number | null = null;
    try {
      j = m.startPointScore(positions);
    } catch {
      return null;
    }
    if (j !== null) this.hints += 1;
    return j;
  }

  /** One tick. Returns the frame to force, or `null` to let legacy playback run. */
  onTick(nowMs: number, currentFrame: number, micOpenness: number | null, avatarTalking: boolean): number | null {
    this.ticks += 1;
    const m = this.matcher;
    this.mic?.push(micOpenness, avatarTalking);
    if (!m || !this.opt.blinkDetour) return null;
    let edge = false;
    try {
      edge = m.blinkEdge(nowMs);
    } catch {
      edge = false;
    }
    const [force, home] = this.detour.tick(Math.trunc(currentFrame), edge, (i) =>
      m.blinkFrameNear(i, this.opt.blinkMaxDelta),
    );
    if (home !== null && this.host) {
      // hand the cursor back exactly where the sequence was, then let legacy run
      this.host.currentFrameIndex = Math.trunc(home);
    }
    if (force === null) return null;
    this.forcedTicks += 1;
    return Math.trunc(force);
  }

  stats(): Record<string, unknown> {
    return {
      engine: 'legacy',
      ticks: this.ticks,
      forcedTicks: this.forcedTicks,
      blinkDetours: this.detour.detours,
      blinkMisses: this.detour.misses,
      startPointHints: this.hints,
      micTalk: !!this.mic?.owner,
      micLevel: this.mic ? Math.round(this.mic.level * 1000) / 1000 : null,
      micTalkPct: this.mic ? Math.round(this.mic.talkPct * 10) / 10 : null,
    };
  }
}
