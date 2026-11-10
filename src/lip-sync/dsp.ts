/**
 * LipSyncDsp — EMA smoothing + decaying-peak AGC + voicing gate.
 *
 * This is a port of the DESKTOP player's TTS path
 * (`ania_player/plugins/voice_assistant/voice_bridge.py`, `on_tts_chunk` +
 * `_detect_speech`). The desktop is fed one audio block every ~30 ms, so every
 * constant there is expressed PER BLOCK. The web has no such luxury: we are
 * polled from `requestAnimationFrame`, which is 60 Hz on most machines, 120 Hz
 * on a high-refresh laptop, and 0 Hz in a background tab.
 *
 * Hard-coding the per-block constants would therefore make the avatar behave
 * differently on a 120 Hz display than on a 60 Hz one — a bug that is nearly
 * impossible to reproduce in the field, because the reporter's hardware is the
 * variable. So every constant below is re-derived from `dt` on each call:
 *
 *   EMA   `s = 0.6a + 0.4s` per 30 ms  ->  retention 0.4 per 30 ms
 *                                          half-life = 30*ln(0.5)/ln(0.4)  = 22.7 ms
 *   AGC   `peak *= 0.995`     per 30 ms  ->  half-life = 30*ln(0.5)/ln(0.995) = 4149 ms
 *   gate open   `> 1 block`  @30 ms  ->  60 ms
 *   gate close  `> 5 blocks` @30 ms  ->  180 ms
 *
 * Nothing in this file reads a clock or a random number: `dtMs` is injected by
 * the caller. That is the whole reason this module is testable under plain
 * `node` (see `examples/test-lip-dsp.mjs`).
 */

/**
 * Upper bound on a single `dt`, in ms.
 *
 * The caller measures `dt` from the rAF timestamp. A tab that was frozen
 * (backgrounded, laptop lid closed, a long synchronous task) hands us a `dt` of
 * seconds. Without this clamp, ONE such call would decay the AGC peak straight
 * down to its 0.05 floor, and the next quiet syllable would normalise to 1.0 —
 * i.e. the mouth slams wide open on a quiet phrase ending. That is exactly the
 * regression the desktop's `0.995` comment documents (it happened there with
 * the older, faster `0.97` decay), and it is worth repeating: a slow decay is
 * only slow if no single step is allowed to be huge.
 */
const MAX_DT_MS = 100;

/** Reference block size the desktop's per-block constants were measured at. */
const REF_BLOCK_MS = 30;

/** EMA retention per reference block (`s = 0.6a + 0.4s` -> 0.4 stays). */
const EMA_RETENTION_PER_BLOCK = 0.4;

/** AGC peak retention per reference block. */
const PEAK_DECAY_PER_BLOCK = 0.995;

const clampDt = (dtMs: number): number => {
  const dt = Number(dtMs);
  if (!Number.isFinite(dt)) return 0;
  return Math.min(MAX_DT_MS, Math.max(0, dt));
};

/**
 * A source that is PRESENT but silent must read as `0`, never as "no data".
 * The whole silence branch of the animator depends on being *fed* zeros: a
 * `null`/`NaN` reading used to fall through to the blind frame cycler, which is
 * why the mouth kept flapping after the audio ended.
 */
const finiteOrZero = (value: number | null | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** `Number.isFinite(x) ? x : fallback`, with the option's type preserved. */
const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Tuning knobs for {@link LipSyncDsp}. Every one has a desktop-derived default. */
export interface LipSyncDspOptions {
  /** RMS above which the source counts as voiced. Default 0.020 (~ -34 dBFS). */
  amplitudeThreshold?: number;
  /** Time above the threshold before the gate opens. Default 60 ms. */
  gateOpenMs?: number;
  /** Time below the threshold before the gate closes. Default 180 ms. */
  gateCloseMs?: number;
  /** Floor under the AGC peak. Default 0.05. */
  peakFloor?: number;
  /** Reference window the EMA retention was measured over. Default 30 ms. */
  emaHalfLifeRefMs?: number;
  /** Reference window the peak decay was measured over. Default 30 ms. */
  peakDecayRefMs?: number;
  /**
   * Adaptive gate threshold. Default true. A fixed 0.020 RMS left quiet TTS
   * voices (a Piper voice without peak normalisation sits ~7 dB lower) below the
   * gate on weak syllables and phrase endings: audio came out and the mouth
   * stayed shut. With this on, the effective threshold is
   * `clamp(max(levelPeak * adaptiveRatio, noiseFloor * noiseRatio), minThreshold, amplitudeThreshold)`:
   * never above the old fixed value, so loud sources behave exactly as before.
   */
  adaptiveThreshold?: boolean;
  /** Fraction of the recent speech level that counts as voiced. Default 0.12 (-18 dB). */
  adaptiveRatio?: number;
  /** Multiple of the tracked noise floor the gate stays above. Default 3 (+9.5 dB). */
  noiseRatio?: number;
  /** Lowest threshold the adaptive gate may reach. Default 0.010 (-40 dBFS): steady room noise below it never opens, even before the floor tracker settles. */
  minThreshold?: number;
}

/** One DSP reading, as returned by {@link LipSyncDsp.poll}. */
export interface LipSyncDspReading {
  /** AGC-normalised loudness, 0..1. */
  amplitude: number;
  /** Mouth openness, 0..1 — spectral when available, `amplitude * 1.1` otherwise. */
  openness: number;
  /** Whether the voicing gate is currently open. */
  gateOpen: boolean;
  /** The raw EMA of the input, before normalisation. */
  smoothed: number;
  /** The decaying AGC reference peak. */
  peak: number;
}

export class LipSyncDsp {
  /** RMS above which the source counts as voiced (~ -34 dBFS in float [-1,1]). */
  public amplitudeThreshold: number;
  /** Time above the threshold before the gate opens. Desktop: 1 block @30 ms. */
  public gateOpenMs: number;
  /** Time below the threshold before the gate closes. Desktop: 5 blocks @30 ms. */
  public gateCloseMs: number;
  /**
   * Floor under the AGC peak. Without it, a near-silent source divides by a
   * near-zero peak and every faint breath normalises to a fully open mouth.
   */
  public peakFloor: number;
  public emaHalfLifeRefMs: number;
  public peakDecayRefMs: number;
  public adaptiveThreshold: boolean;
  public adaptiveRatio: number;
  public noiseRatio: number;
  public minThreshold: number;
  /** Slow-decaying peak of the RAW rms (speech level). Survives `reset()`. */
  public levelPeak = 0;
  /** Tracked noise floor: falls fast, rises slowly. Survives `reset()`. */
  public noiseFloor = 0;

  /** EMA of the raw RMS. */
  public smoothed = 0;
  /** EMA of the optional externally supplied openness (spectral path). */
  public opennessSmoothed = 0;
  /** Decaying peak used as the AGC reference for `smoothed`. */
  public peak: number;
  /** Same, for the optional spectral openness channel. */
  public opennessPeak: number;
  public amplitude = 0;
  public openness = 0;
  public gateOpen = false;
  public openMs = 0;
  public closeMs = 0;

  constructor(options: LipSyncDspOptions = {}) {
    this.amplitudeThreshold = finiteOr(options.amplitudeThreshold, 0.02);
    this.gateOpenMs = finiteOr(options.gateOpenMs, 60);
    this.gateCloseMs = finiteOr(options.gateCloseMs, 180);
    this.peakFloor = finiteOr(options.peakFloor, 0.05);
    this.emaHalfLifeRefMs = finiteOr(options.emaHalfLifeRefMs, REF_BLOCK_MS);
    this.peakDecayRefMs = finiteOr(options.peakDecayRefMs, REF_BLOCK_MS);
    this.adaptiveThreshold = options.adaptiveThreshold !== false;
    this.adaptiveRatio = finiteOr(options.adaptiveRatio, 0.12);
    this.noiseRatio = finiteOr(options.noiseRatio, 3);
    this.minThreshold = finiteOr(options.minThreshold, 0.01);

    this.peak = this.peakFloor;
    this.opennessPeak = this.peakFloor;
    this.reset();
  }

  /**
   * Zero every temporal accumulator. Call on the idle->talking edge: state left
   * over from the PREVIOUS utterance (a peak still sitting at 1.0, a gate still
   * counting down) makes the first syllable of the new one animate wrong.
   */
  reset(): void {
    this.smoothed = 0;
    this.opennessSmoothed = 0;
    this.peak = this.peakFloor;
    this.opennessPeak = this.peakFloor;
    this.amplitude = 0;
    this.openness = 0;
    this.gateOpen = false;
    this.openMs = 0;
    this.closeMs = 0;
  }

  /**
   * Gate threshold for this poll. Fixed `amplitudeThreshold` when the adaptive
   * gate is off; otherwise relative to the recent speech level (same 4 s
   * half-life as the AGC) and kept above the noise floor, so breath and room
   * noise stay closed while a quiet voice still opens.
   */
  threshold(dt = 0, raw = 0): number {
    if (!this.adaptiveThreshold) return this.amplitudeThreshold;
    if (dt > 0) {
      const decay = Math.pow(PEAK_DECAY_PER_BLOCK, dt / this.peakDecayRefMs);
      this.levelPeak = Math.max(this.levelPeak * decay, raw);
      // noise floor: falls in ~100 ms (any pause between phrases pulls it down),
      // rises with an 8 s half-life (steady room noise gets in; speech barely moves it)
      const k = raw < this.noiseFloor ? 1 - Math.exp(-dt / 100) : 1 - Math.pow(0.5, dt / 8000);
      this.noiseFloor += (raw - this.noiseFloor) * k;
    }
    const rel = Math.max(this.levelPeak * this.adaptiveRatio, this.noiseFloor * this.noiseRatio);
    return Math.min(this.amplitudeThreshold, Math.max(this.minThreshold, rel));
  }

  isGateOpen(): boolean {
    return this.gateOpen;
  }

  /**
   * Advance the DSP by `dtMs` of wall clock with a new raw reading.
   *
   * @param dtMs   elapsed ms since the previous poll (clamped internally)
   * @param rawRms RMS of the current audio, in [0,1]. Non-finite -> 0.
   * @param rawOpenness optional richer openness estimate.
   *
   *   The desktop's TTS path uses the cheap `amplitude * 1.1` proxy — voiced
   *   segments are usually the loud ones, and a per-block FFT would just burn
   *   CPU. Its MIC path uses `0.7*amp**0.6 + 0.3*lowFreqRatio*amp`, which needs
   *   spectral data. On the web the analyser already exists, so the host can
   *   hand us that richer value here. When `rawOpenness` is a finite number it
   *   is smoothed and AGC-normalised through its OWN channel (same constants)
   *   and replaces the proxy. The gate always keys off `rawRms`, never off
   *   `rawOpenness` — the gate's 0.020 threshold is calibrated in RMS units and
   *   means nothing on a 0..1 openness curve.
   */
  poll(dtMs: number, rawRms: number, rawOpenness?: number | null): LipSyncDspReading {
    const dt = clampDt(dtMs);
    const raw = Math.max(0, finiteOrZero(rawRms));

    // --- 1. EMA. Exact exponential form, so two half-steps compose into one
    // full step: that is what makes the output identical at 60 and 120 Hz.
    const emaK = 1 - Math.pow(EMA_RETENTION_PER_BLOCK, dt / this.emaHalfLifeRefMs);
    this.smoothed += (raw - this.smoothed) * emaK;

    // --- 2. AGC. Slow decay + floor. The desktop moved from 0.97 (half-life
    // ~0.7 s) to 0.995 (~4.1 s) because on a long sentence the peak fell along
    // with the softer prosody of the phrase ending, the normalised amplitude
    // inflated, and the mouth hit maximum on quiet audio.
    const peakDecay = Math.pow(PEAK_DECAY_PER_BLOCK, dt / this.peakDecayRefMs);
    this.peak = Math.max(this.peak * peakDecay, this.smoothed, this.peakFloor);

    // --- 3. Normalise into a usable 0..1 band.
    this.amplitude = Math.min(1, this.smoothed / Math.max(this.peak, 1e-6));

    // --- 4. Openness: spectral channel when available, cheap proxy otherwise.
    const hasSpectral = Number.isFinite(Number(rawOpenness));
    if (hasSpectral) {
      const rawOpen = Math.max(0, Number(rawOpenness));
      this.opennessSmoothed += (rawOpen - this.opennessSmoothed) * emaK;
      this.opennessPeak = Math.max(
        this.opennessPeak * peakDecay,
        this.opennessSmoothed,
        this.peakFloor
      );
      this.openness = Math.min(1, this.opennessSmoothed / Math.max(this.opennessPeak, 1e-6));
    } else {
      this.openness = Math.min(1, this.amplitude * 1.1);
    }

    // --- 5. Voicing gate with hysteresis. Short to open (the mouth must not
    // lag the first syllable), long to close (so intra-utterance pauses and the
    // gap between TTS chunks do not make the jaw flutter).
    if (raw > this.threshold(dt, raw)) {
      this.closeMs = 0;
      this.openMs += dt;
      if (!this.gateOpen && this.openMs > this.gateOpenMs) {
        this.gateOpen = true;
      }
    } else {
      this.openMs = 0;
      this.closeMs += dt;
      if (this.gateOpen && this.closeMs > this.gateCloseMs) {
        this.gateOpen = false;
        // Collapse the amplitude trail on the CLOSE transition so the envelope
        // downstream returns to rest immediately instead of coasting down the
        // EMA tail (voice_bridge.py:207-212). Without this the mouth keeps
        // moving for ~100 ms after the audio has already stopped.
        this.smoothed = 0;
        this.opennessSmoothed = 0;
        this.amplitude = 0;
        this.openness = 0;
      }
    }

    return {
      amplitude: this.amplitude,
      openness: this.openness,
      gateOpen: this.gateOpen,
      smoothed: this.smoothed,
      peak: this.peak,
    };
  }
}

export default LipSyncDsp;
