/**
 * Frame-rate resolution and clamping.
 *
 * THE BUG THIS EXISTS TO FIX
 *
 * The animation controller computed its per-frame delay as
 *
 *     frameInterval = (1000 / 30) / speedSliderValue
 *
 * with nothing normalising or bounding the result. The speed slider is a bare
 * multiplier against a duration that has no relation to the footage, so its
 * meaning depends entirely on the host. Nearly every consumer app hardcodes
 * `idleSpeed={6.4} talkSpeed={5.3}`, which against that hardcoded 30 fps is
 *
 *     33.3 / 5.3 = 6.3 ms  ->  159 fps
 *
 * while `diario-de-obra` passes 2.8 and lands at 84 fps. Same engine, same
 * component, wildly different playback. That is the "some avatars are slow,
 * others are way too fast" report.
 *
 * THE FIX
 *
 * Stop treating the slider as an absolute divisor. Resolve what the footage's
 * REAL frame rate is, treat the slider as a multiplier relative to that, and
 * clamp the result into a sane window (24-30 fps by default). The legacy 6.4 /
 * 5.3 / 2.8 values then all collapse onto the clamp and become no-ops, so the
 * apps that pass them need no edits.
 *
 * Hosts that genuinely want something else opt out explicitly with `fpsClamp`.
 *
 * This module is pure and imports nothing but a type, so
 * `examples/test-frame-rate.mjs` can exercise it under plain `node`.
 */

import type { AniaAvatarData } from '../types';

/** A playback window, in frames per second. */
export interface FpsClampWindow {
  min: number;
  max: number;
}

/**
 * The `fpsClamp` option as a host may write it: `undefined`/`true` for the
 * default window, `false` to disable clamping, or a custom `{min, max}`.
 */
export type FpsClampOption = boolean | FpsClampWindow | null | undefined;

/** The window playback is held to unless the host opts out. */
export const FPS_CLAMP_DEFAULT: FpsClampWindow = { min: 24, max: 30 };

/**
 * Assumed frame rate when the `.ania` declares none.
 *
 * 25 sits inside the default window, so an undeclared file plays at its assumed
 * rate rather than being dragged to a boundary. Old files predate the studio
 * writing `video.fps` at all, and there are plenty of them in the wild.
 */
export const FPS_FALLBACK = 25;

/**
 * The legacy default for `idleFrameDuration`/`talkCycleDuration`.
 *
 * This value means "nobody set this", NOT "20 fps". Studio-authored files carry
 * a real, fps-correct duration (~1000/fps); files that predate that carry 50
 * because 50 was the hardcoded fallback. Reading 50 as a genuine 20 fps would
 * make every legacy avatar play 20% slow, so it is explicitly not trusted as an
 * fps source.
 */
const LEGACY_DURATION_SENTINEL = 50;

const isPositiveFinite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/** What {@link resolveNativeFps} decided, and which signal decided it. */
export interface NativeFps {
  fps: number;
  /** `video.fps` | `config.idleFrameDuration` | `frames/duration` | `fallback`. */
  source: 'video.fps' | 'config.idleFrameDuration' | 'frames/duration' | 'fallback';
}

/**
 * Loose view of the `video` block.
 *
 * `AniaAvatarData['video']` declares only `frames`/`fps`/`width`/`height`, but
 * studio exports also carry `frameCount` and `duration`, and older files carry
 * one without the other. Reading them through this shape keeps the last-resort
 * branch working without widening the public avatar type.
 */
interface VideoLike {
  fps?: unknown;
  frames?: unknown;
  frameCount?: unknown;
  duration?: unknown;
}

interface ConfigLike {
  idleFrameDuration?: unknown;
}

/**
 * Normalise the `fpsClamp` option into a `{min, max}` window, or `null` for
 * "off".
 *
 * Accepts: `undefined`/`true` -> the default window; `false` -> no clamping at
 * all (full legacy behaviour); `{min, max}` -> a custom window.
 *
 * An invalid custom window falls back to the default rather than throwing: this
 * runs on the load path of every host app, and a bad option should degrade to
 * correct playback, not to a blank avatar.
 */
export const normalizeFpsClamp = (fpsClamp?: FpsClampOption): FpsClampWindow | null => {
  if (fpsClamp === false) return null;
  if (fpsClamp === undefined || fpsClamp === null || fpsClamp === true) {
    return { ...FPS_CLAMP_DEFAULT };
  }
  if (typeof fpsClamp === 'object') {
    const min = Number((fpsClamp as FpsClampWindow).min);
    const max = Number((fpsClamp as FpsClampWindow).max);
    if (isPositiveFinite(min) && isPositiveFinite(max) && min <= max && max <= 120) {
      return { min, max };
    }
    console.warn(
      '[ania-avatar-core] fpsClamp must be {min, max} with 0 < min <= max <= 120; ' +
        'falling back to the default 24-30 fps window. Got:',
      fpsClamp
    );
  }
  return { ...FPS_CLAMP_DEFAULT };
};

/**
 * Work out the true frame rate of the avatar's footage.
 *
 * `source` names which signal won, for logging — when playback looks wrong, the
 * first question is always "what did it think the fps was, and why".
 */
export const resolveNativeFps = (avatarData?: AniaAvatarData | null): NativeFps => {
  const data = avatarData || ({} as Partial<AniaAvatarData>);
  const video = (data.video || {}) as VideoLike;
  const config = (data.config || {}) as ConfigLike;

  // 1. The studio writes this. Trust it first.
  const declared = Number(video.fps);
  if (isPositiveFinite(declared) && declared <= 240) {
    return { fps: declared, source: 'video.fps' };
  }

  // 2. Studio-authored files also carry an fps-correct frame duration. Usable,
  //    but only when it is not the "nobody set this" sentinel.
  const idleMs = Number(config.idleFrameDuration);
  if (isPositiveFinite(idleMs) && idleMs !== LEGACY_DURATION_SENTINEL) {
    const derived = 1000 / idleMs;
    if (derived >= 8 && derived <= 120) {
      return { fps: derived, source: 'config.idleFrameDuration' };
    }
  }

  // 3. Last resort before guessing: frame count over clip duration.
  const frameCount = Array.isArray(video.frames)
    ? video.frames.length
    : Number(video.frameCount);
  const duration = Number(video.duration);
  if (
    isPositiveFinite(frameCount) &&
    frameCount > 1 &&
    isPositiveFinite(duration) &&
    duration > 0.5
  ) {
    const derived = frameCount / duration;
    if (derived >= 8 && derived <= 120) {
      return { fps: derived, source: 'frames/duration' };
    }
  }

  return { fps: FPS_FALLBACK, source: 'fallback' };
};

/** Arguments to {@link frameIntervalMs}. */
export interface FrameIntervalArgs {
  /** From {@link resolveNativeFps}. */
  nativeFps?: number;
  /** Host/file speed multiplier relative to the native rate. */
  speed?: number;
  /** A second, global scalar (e.g. a runtime playback-speed control). */
  playbackSpeed?: number;
  /** From {@link normalizeFpsClamp}; `null` disables clamping. */
  clamp?: FpsClampWindow | null;
}

/**
 * The per-frame interval, in ms, that the controller should actually use.
 *
 * `speed` is a multiplier relative to the footage's native rate: 1 means "play
 * it as shot". The clamp then bounds the result, which is what neutralises the
 * legacy absolute values.
 */
export const frameIntervalMs = ({
  nativeFps,
  speed = 1,
  playbackSpeed = 1,
  clamp = FPS_CLAMP_DEFAULT,
}: FrameIntervalArgs = {}): number => {
  const fps = isPositiveFinite(nativeFps) ? nativeFps : FPS_FALLBACK;
  const s = isPositiveFinite(speed) ? speed : 1;
  const ps = isPositiveFinite(playbackSpeed) ? playbackSpeed : 1;

  const raw = 1000 / fps / s / ps;
  if (!clamp) return raw;

  const minMs = 1000 / clamp.max; // fastest allowed -> shortest interval
  const maxMs = 1000 / clamp.min; // slowest allowed -> longest interval
  return Math.max(minMs, Math.min(maxMs, raw));
};

/** Convenience for logs and tests: the effective fps of an interval. */
export const fpsFromIntervalMs = (intervalMs: number): number =>
  isPositiveFinite(intervalMs) ? 1000 / intervalMs : 0;

/**
 * Frame pacing accumulator.
 *
 * NOT part of `frame-rate.js` upstream — there it lives inline in the runtime
 * extension as `AnimationController.prototype._advanceDue`
 * (`player-runtime/src/ext/index.js`). It is lifted into this module verbatim,
 * as a class, for exactly one reason: it is the fix for a numerically-measured
 * bug and it deserves the same plain-`node` test coverage as everything else
 * here. The algorithm is unchanged.
 *
 * THE BUG
 *
 * The old gate was `if (now - lastFrameTime < interval) return -1;` followed by
 * `lastFrameTime = now`. Because `now` is when the poll happened rather than
 * when the frame was DUE, every frame is pushed out to the next poll boundary
 * and the leftover is discarded. The effective rate is therefore always at or
 * below target, by an amount that depends on how the poll rate and the interval
 * beat against each other:
 *
 *   poll 30 Hz, interval 41.67 ms  -> 2 polls per frame -> 15.0 fps
 *   poll 60 Hz, interval 41.67 ms  -> 3 polls per frame -> 20.0 fps
 *   poll 120 Hz, interval 41.67 ms -> 5 polls per frame -> 24.0 fps
 *
 * That was invisible before, because the interval used to be ~6 ms (the 159 fps
 * bug): shorter than any poll period, so every poll advanced a frame and
 * playback simply ran at the display's refresh rate. Clamping the interval to a
 * real 24-30 fps is what exposed it.
 *
 * Carrying the remainder in an accumulator makes the AVERAGE rate correct
 * regardless of poll phase.
 */
export class FramePacer {
  /** When the next frame is due, on the caller's clock. `null` = unanchored. */
  public due: number | null = null;
  /** The last poll at which a frame was emitted. Legacy-path bookkeeping. */
  public lastFrameTime = 0;

  /**
   * Is a frame due? Advances the accumulator by exactly one interval when it
   * is.
   *
   * `paced` false keeps the original "reset to now" behaviour, so a host that
   * opted out of the fps clamp sees no change at all.
   */
  advanceDue(now: number, interval: number, paced: boolean): boolean {
    if (!paced) {
      if (now - this.lastFrameTime < interval) return false;
      this.lastFrameTime = now;
      return true;
    }
    if (this.due === null) this.due = now;
    if (now < this.due) return false;
    this.due += interval;
    // After a stall (a hidden tab, a long task) the due time can be many
    // intervals in the past. Re-anchor instead of firing a burst of catch-up
    // frames, which would read as a fast-forward.
    if (now - this.due > interval) this.due = now + interval;
    this.lastFrameTime = now;
    return true;
  }

  /** Drop the anchor so the next poll starts a fresh cadence. */
  reanchor(): void {
    this.due = null;
  }
}
