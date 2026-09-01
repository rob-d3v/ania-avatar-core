/**
 * LipAnimator — envelope, sustain detection, branch selection and the
 * ping-pong frame sweep. Port of the desktop player's
 * `AnimationController._update_talk_animation_lips_sync`
 * (`ania_player/animation_controller.py:347-461`).
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * The desktop does NOT look the frame up from the openness map while speech is
 * happening. That is what this engine used to do (`frameForOpenness`: openness
 * -> nearest matching frame) and it is the reason the mouth read as random
 * rather than synchronised.
 *
 * What the desktop actually does is sweep the frame index +-1 back and forth
 * across the talk range, and let the audio envelope SHORTEN THE PER-FRAME
 * DELAY. Louder speech sweeps faster, so the mouth flaps faster. This works
 * because the talk range of the source footage *is itself* an open-close mouth
 * cycle — the footage already contains the articulation; all we control is how
 * fast we walk through it.
 *
 * So: `step()` decides WHICH frame, `intervalScale()` decides HOW FAST, and the
 * openness map is consulted in exactly one place — finding the closed-mouth
 * frame to park on during silence.
 *
 * ---------------------------------------------------------------------------
 * Time, not ticks
 * ---------------------------------------------------------------------------
 * Every desktop constant here is per-tick at 16.67 ms (its 60 Hz animation
 * loop). We are polled from `requestAnimationFrame`: 60 Hz usually, 120 Hz on a
 * high-refresh display, 0 Hz in a background tab. So each constant is
 * re-derived from `dt`:
 *
 *   attack/release alpha   `a_dt = 1 - (1-a)**(dt/16.667)`
 *   sustain counter        `+= dt/16.667` (cap 30) / `-= 3*dt/16.667` (floor 0)
 *   sustain history        12 samples @16.67 ms -> a 200 ms time window
 *   wiggle phase           1/20 cycle @16.67 ms -> a 333.3 ms period
 *
 * No clock and no RNG are read in this file; `dtMs` is injected. That is what
 * makes it testable under plain `node` (`examples/test-lip-animator.mjs`).
 */

import type { LipSyncSustainStyle } from '../types';

/**
 * Same guard as `dsp.ts`, and for the same reason: a frozen tab hands the
 * caller a `dt` of seconds. One unclamped step would slam the envelope to the
 * current input and drain the sustain counter to zero in a single frame.
 */
const MAX_DT_MS = 100;

/** Reference animation tick the desktop's per-tick constants were measured at. */
const REF_TICK_MS = 16.667;

/** Sustain history window. Desktop: 12 samples at 16.67 ms. */
const SUSTAIN_WINDOW_MS = 200;

/**
 * Minimum samples in the window before stability is judged at all. Desktop
 * requires its full 12-sample buffer; on the web the sample count depends on
 * the refresh rate, so we key off a floor that a 30 Hz poll still reaches
 * inside the 200 ms window.
 */
const SUSTAIN_MIN_SAMPLES = 6;

/** Wiggle period. Desktop: 20 ticks per cycle at 16.67 ms. */
const WIGGLE_PERIOD_MS = 333.3;

/** Sustain counter: entry threshold, cap, and the asymmetric drain rate. */
const SUSTAIN_ENTER = 8;
const SUSTAIN_CAP = 30;
const SUSTAIN_DRAIN = 3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const clampDt = (dtMs: number): number => {
  const dt = Number(dtMs);
  if (!Number.isFinite(dt)) return 0;
  return Math.min(MAX_DT_MS, Math.max(0, dt));
};

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Relative index of the most closed-mouth frame in the openness map.
 *
 * Port of the desktop's `_find_best_frame_for_openness(0.0)`
 * (`animation_controller.py:318-335`):
 *
 *   score(i) = |map[i] - 0| + |i - currentRel| * proximityWeight
 *   proximityWeight = 0.1 / max(1, mapLen - 1)
 *
 * The proximity term is a TIEBREAK, deliberately weighted so that the whole map
 * width is worth 0.1 openness units — it can never beat a genuinely more closed
 * frame, but among equally closed candidates the nearest one wins. Without it
 * the mouth teleports across the loop every time silence starts, because most
 * talk ranges contain the closed pose several times.
 *
 * @param opennessMap per-frame openness, index 0 == talkLow
 * @param currentRel current frame relative to talkLow
 * @param mapLen number of usable entries in the map
 * @returns relative index (the caller adds talkLow)
 */
export const findClosedFrame = (
  opennessMap: number[] | null | undefined,
  currentRel: number,
  mapLen: number
): number => {
  const len = Math.min(
    Number.isFinite(mapLen) ? Math.floor(mapLen) : 0,
    Array.isArray(opennessMap) ? opennessMap.length : 0
  );
  // No map at all: park on talkLow. This is the graceful path for avatars whose
  // `.ania` carries no lip sync config and whose host opted out of autofetch —
  // the sweep model (branch C) still works fully without a map.
  if (len <= 0) return 0;

  const map = opennessMap as number[];
  const cur = clamp(Number.isFinite(currentRel) ? currentRel : 0, 0, len - 1);
  const proximityWeight = 0.1 / Math.max(1, len - 1);

  let bestIdx = Math.round(cur);
  let bestScore = Infinity;
  for (let i = 0; i < len; i++) {
    const value = Number(map[i]);
    const opennessDiff = Math.abs(Number.isFinite(value) ? value : 0);
    const score = opennessDiff + Math.abs(i - cur) * proximityWeight;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
};

/** Which branch the last {@link LipAnimator.step} took. */
export type LipAnimatorBranch = 'sustain' | 'silence' | 'voiced';

/** Live-reconfigurable tuning for {@link LipAnimator}. */
export interface LipAnimatorOptions {
  /** 0..1 openness boost. Default 0.6. */
  intensity?: number;
  /** 0.05..1 envelope responsiveness (higher = snappier). Default 0.5. */
  responsiveness?: number;
  /** What a held vowel does. Default 'wiggle'. */
  sustainStyle?: LipSyncSustainStyle;
  /** 1..6 wiggle amplitude in frames. Default 2. */
  wiggleSpeed?: number;
  /** 1..4.5 loud/quiet sweep-speed ratio. Default 2.237. */
  maxSweepBoost?: number;
  /** Envelope below which the mouth is treated as shut. Default 0.06. */
  silenceThreshold?: number;
  /** How long the gate must stay shut before the snap budget arms. Default 250 ms. */
  snapAfterMs?: number;
  /** Frames per tick the close budget allows at minimum. Default 3. */
  maxSnapStep?: number;
  /** How long the mouth may take to shut once the close budget arms. Default 200 ms. */
  closeMs?: number;
}

/** Arguments to {@link LipAnimator.step}. */
export interface LipAnimatorStepArgs {
  currentFrame?: number;
  talkLow?: number;
  talkHigh?: number;
  opennessMap?: number[] | null;
}

interface HistorySample {
  t: number;
  v: number;
}

export class LipAnimator {
  public intensity = 0.6;
  public responsiveness = 0.5;
  public sustainStyle: LipSyncSustainStyle = 'wiggle';
  public wiggleSpeed = 2;
  public maxSweepBoost = 2.237;
  public silenceThreshold = 0.06;
  public snapAfterMs = 250;
  public maxSnapStep = 3;
  public closeMs = 200;
  /** EMA of the host's poll interval, used to turn `closeMs` into a step. */
  public tickMs = REF_TICK_MS;

  public envelope = 0;
  public wigglePhase = 0;
  public history: HistorySample[] = [];
  public historyTime = 0;
  public sustainCounter = 0;
  public inSustain = false;
  public anchor: number | null = null;
  public direction = 1;
  public gateClosedMs = 0;
  public branch: LipAnimatorBranch = 'silence';

  constructor(options: LipAnimatorOptions = {}) {
    this.configure(options);
    this.reset();
  }

  /**
   * Live reconfiguration — the host can change `lipSyncIntensity` and friends
   * at runtime, and nothing here depends on the previous values, so there is no
   * need to tear the animator down and lose the envelope mid-sentence.
   */
  configure(options: LipAnimatorOptions = {}): this {
    const o = options || {};
    if ('intensity' in o) {
      this.intensity = clamp(num(o.intensity, this.intensity), 0, 1);
    }
    if ('responsiveness' in o) {
      this.responsiveness = clamp(num(o.responsiveness, this.responsiveness), 0.05, 1);
    }
    if ('sustainStyle' in o) {
      const style = o.sustainStyle || this.sustainStyle || 'wiggle';
      this.sustainStyle = style === 'hold' ? 'hold' : 'wiggle';
    }
    if ('wiggleSpeed' in o) {
      this.wiggleSpeed = clamp(num(o.wiggleSpeed, this.wiggleSpeed), 1, 6);
    }
    if ('maxSweepBoost' in o) {
      this.maxSweepBoost = clamp(num(o.maxSweepBoost, this.maxSweepBoost), 1, 4.5);
    }
    if ('silenceThreshold' in o) {
      this.silenceThreshold = num(o.silenceThreshold, this.silenceThreshold);
    }
    if ('snapAfterMs' in o) {
      this.snapAfterMs = num(o.snapAfterMs, this.snapAfterMs);
    }
    if ('maxSnapStep' in o) {
      this.maxSnapStep = Math.max(1, Math.round(num(o.maxSnapStep, this.maxSnapStep)));
    }
    if ('closeMs' in o) {
      this.closeMs = clamp(num(o.closeMs, this.closeMs), 60, 1500);
    }
    return this;
  }

  /**
   * Idle->talking edge. Everything temporal has to go, or the first syllable of
   * the new utterance is animated with the tail of the previous one: a hot
   * envelope opens the mouth before any audio, and a hot sustain counter parks
   * it on a stale anchor.
   */
  reset(): void {
    this.envelope = 0;
    this.wigglePhase = 0;
    this.history = [];
    this.historyTime = 0;
    this.sustainCounter = 0;
    this.inSustain = false;
    this.anchor = null;
    this.direction = 1;
    this.gateClosedMs = 0;
    this.branch = 'silence';
    this.tickMs = REF_TICK_MS;
  }

  getEnvelope(): number {
    return this.envelope;
  }

  /** 'sustain' | 'silence' | 'voiced' — the branch the last `step()` took. */
  lastBranch(): LipAnimatorBranch {
    return this.branch;
  }

  /**
   * Advance the temporal state by `dtMs` with a new raw openness reading.
   *
   * Call this on EVERY rAF, independent of the frame gate. The frame gate only
   * decides when the picture is allowed to advance; if the envelope were only
   * updated when a frame is emitted it would be sampled at the very rate it is
   * supposed to be controlling, and the whole loop would alias.
   *
   * @param dtMs elapsed ms since the previous poll (clamped internally)
   * @param rawOpenness 0..1 openness. Non-finite -> 0 (silence).
   */
  poll(dtMs: number, rawOpenness: number): number {
    const dt = clampDt(dtMs);
    const rawNum = Number(rawOpenness);
    const raw = clamp(Number.isFinite(rawNum) ? rawNum : 0, 0, 1);

    // How fast is the host actually calling us? The close budget below is
    // expressed in milliseconds, and turning it into a per-tick step needs to
    // know how long a tick is. An EMA rather than the raw dt so one hitched
    // frame does not make the mouth lurch.
    this.tickMs = this.tickMs * 0.9 + dt * 0.1;

    // --- Boost. At the production intensity 0.79 this gain is 1.664.
    const boosted = Math.min(1, raw * (0.4 + 1.6 * this.intensity));

    // --- Sustain detection over a 200 ms time window (desktop: 12 samples at
    // 16.67 ms). Keying the ring buffer on accumulated TIME rather than a
    // sample count is what keeps the detector identical at 60 and 120 Hz — a
    // fixed 12-sample buffer would cover 100 ms on a 120 Hz display and would
    // therefore latch onto sustain twice as eagerly there.
    this.historyTime += dt;
    this.history.push({ t: this.historyTime, v: raw });
    const cutoff = this.historyTime - SUSTAIN_WINDOW_MS;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();

    let isStable = false;
    if (this.history.length >= SUSTAIN_MIN_SAMPLES) {
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const s of this.history) {
        sum += s.v;
        if (s.v < min) min = s.v;
        if (s.v > max) max = s.v;
      }
      const mean = sum / this.history.length;
      if (mean > 0.15) {
        let variance = 0;
        for (const s of this.history) variance += (s.v - mean) * (s.v - mean);
        variance /= this.history.length;
        const relStd = Math.sqrt(variance) / mean;
        isStable = relStd < 0.05 && max - min < 0.07;
      }
    }

    const ticks = dt / REF_TICK_MS;
    if (isStable) {
      this.sustainCounter = Math.min(SUSTAIN_CAP, this.sustainCounter + ticks);
    } else {
      // Drains 3x faster than it fills: a held vowel has to prove itself, but
      // the moment articulation resumes the wiggle must get out of the way.
      this.sustainCounter = Math.max(0, this.sustainCounter - SUSTAIN_DRAIN * ticks);
    }
    this.inSustain = this.sustainCounter >= SUSTAIN_ENTER;

    if (this.inSustain) {
      this.wigglePhase += (2 * Math.PI * dt) / WIGGLE_PERIOD_MS;
    } else {
      // Desktop resets `_lips_micro_time` when it leaves sustain, so the next
      // held vowel starts its wiggle from the anchor instead of from wherever
      // the sine happened to be.
      this.wigglePhase = 0;
      this.anchor = null;
    }

    // --- Asymmetric envelope. At the production responsiveness 0.24 the attack
    // alpha is 0.696 and the release alpha 0.422: the mouth opens ~1.65x faster
    // than it closes, which is what reads as "articulate" instead of "twitchy".
    const delta = boosted - this.envelope;
    const aPer =
      delta > 0
        ? Math.min(1, 0.6 + 0.4 * this.responsiveness)
        : Math.min(1, 0.35 + 0.3 * this.responsiveness);
    // `aPer === 1` means "jump to target in one reference tick"; Math.pow(0, x)
    // would still give the right answer for dt > 0, but not for dt === 0, where
    // 0**0 === 1 and the guard keeps a zero-length frame from moving anything.
    const aDt = aPer >= 1 ? (dt > 0 ? 1 : 0) : 1 - Math.pow(1 - aPer, dt / REF_TICK_MS);
    this.envelope = clamp(this.envelope + delta * aDt, 0, 1);

    // --- Snap budget bookkeeping (see branch B in `step`).
    if (this.envelope < this.silenceThreshold) this.gateClosedMs += dt;
    else this.gateClosedMs = 0;

    return this.envelope;
  }

  /**
   * Multiplier applied to the base (already fps-clamped) frame interval.
   *
   * This is the desktop's `return base_delay * speed_factor` one-for-one. The
   * desktop hard-floors the factor at 0.2, but at the production intensity 0.79
   * its own minimum is `1 - 0.79*0.7*1` = 0.447, so that floor is never
   * reached. Replacing it with `1/maxSweepBoost` is therefore a literal no-op
   * at production settings and only diverges above `intensity > 0.816` — while
   * giving the host a single, honest knob for the loud/quiet sweep RATIO, which
   * is the thing the eye actually reads as "in sync".
   */
  intervalScale(): number {
    const floor = 1 / this.maxSweepBoost;
    return Math.max(floor, 1 - this.intensity * 0.7 * this.envelope);
  }

  /**
   * Pick the next frame index. Three mutually exclusive branches.
   *
   * Every branch moves the frame by at most +-1, with the single exception of
   * branch B under the snap budget (at most +-3). There is never a jump cut:
   * the source footage is a continuous mouth cycle, and skipping frames in it
   * looks like a dropped frame, not like speech.
   *
   * @returns the new absolute frame index
   */
  step({ currentFrame, talkLow, talkHigh, opennessMap }: LipAnimatorStepArgs = {}): number {
    const low = Math.round(num(talkLow, 0));
    const high = Math.round(num(talkHigh, 0));

    // Degenerate range (a .ania with no talk segment, or bad metadata). Every
    // branch collapses to the same single frame rather than producing NaN
    // indices that the renderer would silently draw as a blank canvas.
    if (high <= low) {
      this.branch = this.inSustain
        ? 'sustain'
        : this.envelope < this.silenceThreshold
          ? 'silence'
          : 'voiced';
      return low;
    }

    const cur = clamp(Math.round(num(currentFrame, low)), low, high);

    // --- Branch A: sustain. A held vowel. Freeze on the frame we were on and
    // add a small periodic offset so the face is not a still image.
    if (this.inSustain) {
      this.branch = 'sustain';
      if (this.anchor === null) this.anchor = cur;
      if (this.sustainStyle === 'hold') {
        // INTENTIONAL DIVERGENCE from the desktop: there, 'hold' is a silent
        // no-op — `animation_controller.py:429-436` only handles 'wiggle' and
        // 'hold' falls through to a bare `return`, so it accidentally behaves
        // like wiggle-with-offset-0 only because the anchor was already set.
        // `lipSyncSustainStyle` is a documented public option of this library,
        // so we implement what it says: hold the anchor.
        return this._limitStep(cur, clamp(this.anchor, low, high));
      }
      const offset = Math.round(this.wiggleSpeed * Math.sin(this.wigglePhase));
      return this._limitStep(cur, clamp(this.anchor + offset, low, high));
    }

    this.anchor = null;

    // --- Branch B: silence. Walk to the closed-mouth frame and park there,
    // instead of continuing the ping-pong with no sound coming out.
    if (this.envelope < this.silenceThreshold) {
      this.branch = 'silence';
      const mapLen = Array.isArray(opennessMap) ? opennessMap.length : 0;
      const target = low + findClosedFrame(opennessMap, cur - low, mapLen);
      const distance = target - cur;
      if (distance === 0) return cur;

      // CLOSE BUDGET — a web-specific deviation forced by the lower tick rate.
      // The desktop walks +-1 at 60 Hz; we are clamped to 24-30 fps.
      //
      // This was a flat 3-frames-per-tick cap until a real browser run in
      // `ania-avatar-react` exposed what that costs: the close time is
      // proportional to the DISTANCE, and the distance is wherever the sweep
      // happened to reach when the audio stopped — up to half the talk range.
      // Measured on a 251-frame range, the mouth needed 1.9 s to shut after a
      // sentence, and no machine could do better, because the cap and not the
      // tick rate was the bottleneck.
      //
      // So the budget is a DEADLINE: whatever the distance, cover it within
      // `closeMs` of the gate going quiet. The deadline is absolute rather than
      // recomputed from the full budget each tick — the latter moves a fixed
      // fraction of what is left and converges without ever arriving. Floored
      // at `maxSnapStep` so short distances still animate, ceilinged at a tenth
      // of the range so it never reads as a cut.
      let budget = 1;
      if (this.gateClosedMs > this.snapAfterMs && Math.abs(distance) > 6) {
        const tick = this.tickMs > 0 ? this.tickMs : REF_TICK_MS;
        const remainMs = Math.max(tick, this.snapAfterMs + this.closeMs - this.gateClosedMs);
        const ticksLeft = Math.max(1, Math.round(remainMs / tick));
        const needed = Math.ceil(Math.abs(distance) / ticksLeft);
        const ceiling = Math.max(this.maxSnapStep, Math.ceil((high - low + 1) * 0.1));
        budget = clamp(needed, this.maxSnapStep, ceiling);
      }
      const move = Math.sign(distance) * Math.min(Math.abs(distance), budget);
      return clamp(cur + move, low, high);
    }

    // --- Branch C: voiced. The ping-pong sweep. The openness map is NEVER
    // consulted here: the speed of the sweep carries the articulation, not the
    // choice of frame. See the file header.
    this.branch = 'voiced';
    if (cur >= high) this.direction = -1;
    else if (cur <= low) this.direction = 1;
    return clamp(cur + this.direction, low, high);
  }

  /** Clamp a candidate frame to at most +-1 away from where we are now. */
  private _limitStep(cur: number, candidate: number): number {
    // The wiggle offset can legitimately move more than one frame per tick at a
    // high `wiggleSpeed` (6 * d(sin)/dtick ~= 1.9 at 60 Hz) or after a long
    // `dt`. Both are jump cuts, so the sweep invariant wins over the wiggle
    // shape: the wiggle just trails the sine by a frame or two.
    const d = candidate - cur;
    if (d > 1) return cur + 1;
    if (d < -1) return cur - 1;
    return candidate;
  }
}

export default LipAnimator;
