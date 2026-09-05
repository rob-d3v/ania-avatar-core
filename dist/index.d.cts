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
/** Tuning knobs for {@link LipSyncDsp}. Every one has a desktop-derived default. */
interface LipSyncDspOptions {
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
}
/** One DSP reading, as returned by {@link LipSyncDsp.poll}. */
interface LipSyncDspReading {
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
declare class LipSyncDsp {
    /** RMS above which the source counts as voiced (~ -34 dBFS in float [-1,1]). */
    amplitudeThreshold: number;
    /** Time above the threshold before the gate opens. Desktop: 1 block @30 ms. */
    gateOpenMs: number;
    /** Time below the threshold before the gate closes. Desktop: 5 blocks @30 ms. */
    gateCloseMs: number;
    /**
     * Floor under the AGC peak. Without it, a near-silent source divides by a
     * near-zero peak and every faint breath normalises to a fully open mouth.
     */
    peakFloor: number;
    emaHalfLifeRefMs: number;
    peakDecayRefMs: number;
    /** EMA of the raw RMS. */
    smoothed: number;
    /** EMA of the optional externally supplied openness (spectral path). */
    opennessSmoothed: number;
    /** Decaying peak used as the AGC reference for `smoothed`. */
    peak: number;
    /** Same, for the optional spectral openness channel. */
    opennessPeak: number;
    amplitude: number;
    openness: number;
    gateOpen: boolean;
    openMs: number;
    closeMs: number;
    constructor(options?: LipSyncDspOptions);
    /**
     * Zero every temporal accumulator. Call on the idle->talking edge: state left
     * over from the PREVIOUS utterance (a peak still sitting at 1.0, a gate still
     * counting down) makes the first syllable of the new one animate wrong.
     */
    reset(): void;
    isGateOpen(): boolean;
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
    poll(dtMs: number, rawRms: number, rawOpenness?: number | null): LipSyncDspReading;
}

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
declare const findClosedFrame: (opennessMap: number[] | null | undefined, currentRel: number, mapLen: number) => number;
/** Which branch the last {@link LipAnimator.step} took. */
type LipAnimatorBranch = 'sustain' | 'silence' | 'voiced';
/** Live-reconfigurable tuning for {@link LipAnimator}. */
interface LipAnimatorOptions {
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
interface LipAnimatorStepArgs {
    currentFrame?: number;
    talkLow?: number;
    talkHigh?: number;
    opennessMap?: number[] | null;
}
interface HistorySample {
    t: number;
    v: number;
}
declare class LipAnimator {
    intensity: number;
    responsiveness: number;
    sustainStyle: LipSyncSustainStyle;
    wiggleSpeed: number;
    maxSweepBoost: number;
    silenceThreshold: number;
    snapAfterMs: number;
    maxSnapStep: number;
    closeMs: number;
    /** EMA of the host's poll interval, used to turn `closeMs` into a step. */
    tickMs: number;
    envelope: number;
    wigglePhase: number;
    history: HistorySample[];
    historyTime: number;
    sustainCounter: number;
    inSustain: boolean;
    anchor: number | null;
    direction: number;
    gateClosedMs: number;
    branch: LipAnimatorBranch;
    constructor(options?: LipAnimatorOptions);
    /**
     * Live reconfiguration — the host can change `lipSyncIntensity` and friends
     * at runtime, and nothing here depends on the previous values, so there is no
     * need to tear the animator down and lose the envelope mid-sentence.
     */
    configure(options?: LipAnimatorOptions): this;
    /**
     * Idle->talking edge. Everything temporal has to go, or the first syllable of
     * the new utterance is animated with the tail of the previous one: a hot
     * envelope opens the mouth before any audio, and a hot sustain counter parks
     * it on a stale anchor.
     */
    reset(): void;
    getEnvelope(): number;
    /** 'sustain' | 'silence' | 'voiced' — the branch the last `step()` took. */
    lastBranch(): LipAnimatorBranch;
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
    poll(dtMs: number, rawOpenness: number): number;
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
    intervalScale(): number;
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
    step({ currentFrame, talkLow, talkHigh, opennessMap }?: LipAnimatorStepArgs): number;
    /** Clamp a candidate frame to at most +-1 away from where we are now. */
    private _limitStep;
}

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

/** A playback window, in frames per second. */
interface FpsClampWindow {
    min: number;
    max: number;
}
/**
 * The `fpsClamp` option as a host may write it: `undefined`/`true` for the
 * default window, `false` to disable clamping, or a custom `{min, max}`.
 */
type FpsClampOption = boolean | FpsClampWindow | null | undefined;
/** The window playback is held to unless the host opts out. */
declare const FPS_CLAMP_DEFAULT: FpsClampWindow;
/**
 * Assumed frame rate when the `.ania` declares none.
 *
 * 25 sits inside the default window, so an undeclared file plays at its assumed
 * rate rather than being dragged to a boundary. Old files predate the studio
 * writing `video.fps` at all, and there are plenty of them in the wild.
 */
declare const FPS_FALLBACK = 25;
/** What {@link resolveNativeFps} decided, and which signal decided it. */
interface NativeFps {
    fps: number;
    /** `video.fps` | `config.idleFrameDuration` | `frames/duration` | `fallback`. */
    source: 'video.fps' | 'config.idleFrameDuration' | 'frames/duration' | 'fallback';
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
declare const normalizeFpsClamp: (fpsClamp?: FpsClampOption) => FpsClampWindow | null;
/**
 * Work out the true frame rate of the avatar's footage.
 *
 * `source` names which signal won, for logging — when playback looks wrong, the
 * first question is always "what did it think the fps was, and why".
 */
declare const resolveNativeFps: (avatarData?: AniaAvatarData | null) => NativeFps;
/** Arguments to {@link frameIntervalMs}. */
interface FrameIntervalArgs {
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
declare const frameIntervalMs: ({ nativeFps, speed, playbackSpeed, clamp, }?: FrameIntervalArgs) => number;
/** Convenience for logs and tests: the effective fps of an interval. */
declare const fpsFromIntervalMs: (intervalMs: number) => number;
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
declare class FramePacer {
    /** When the next frame is due, on the caller's clock. `null` = unanchored. */
    due: number | null;
    /** The last poll at which a frame was emitted. Legacy-path bookkeeping. */
    lastFrameTime: number;
    /**
     * Is a frame due? Advances the accumulator by exactly one interval when it
     * is.
     *
     * `paced` false keeps the original "reset to now" behaviour, so a host that
     * opted out of the fps clamp sees no change at all.
     */
    advanceDue(now: number, interval: number, paced: boolean): boolean;
    /** Drop the anchor so the next poll starts a fresh cadence. */
    reanchor(): void;
}

/**
 * PoseDescriptor v1 — the shared pose space of Ania 2.0.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/descriptor.py`.
 * See that file's docstring and `wiki/concepts/ania-2-0-pose-descriptor-and-motion-graph.md`
 * for the full spec. Do not change dim order / meaning / constants without bumping
 * {@link DESCRIPTOR_VERSION} on both sides.
 *
 * Landmark input shapes
 * ----------------------
 * `computeDescriptor` accepts each of face/pose/hands as either:
 *   - a flat row-major `Float64Array | number[]` with a fixed stride: 3 for face
 *     and hands (x, y, z), 4 for pose (x, y, z, visibility) — visibility is always
 *     read from column 3 for a flat pose array;
 *   - an array of MediaPipe-JS-shaped `{x, y, z?, visibility?}` points, in which
 *     case `visibility` is read per-point when present (pose only).
 */
declare const DESCRIPTOR_VERSION = 1;
declare const NDIMS = 48;
declare const NUSED = 40;
/**
 * Revision of the `browRaise` mapping only (see the BROWS block of
 * {@link computeDescriptor}). Revision 1 divided a 0.12-neutral by 0.06 and read
 * +1.00 on 100 % of the frames of both reference drivers — the dim was a constant,
 * so `probeCaps` force-zeroed `caps.brows` while it was in force. Revision 2 re-fits
 * the constants from the measured ratio distributions.
 *
 * Deliberately NOT a {@link DESCRIPTOR_VERSION} bump: a bump invalidates every
 * indexed bank at load time and the frozen matcher parity fixture, while the
 * bank-side half of the §5.1 probe (browRaise span >= 0.15 over >= 2 filled bins)
 * already refuses a bank indexed with the old constants.
 */
declare const BROW_MAPPING_VERSION = 2;
/**
 * Raw brow ratio ((eye centre y - brow y) / cheek width, de-rolled), measured
 * 2026-09-05 over the two reference drivers. The old (0.12, 0.06) pair saturated at
 * +1 for every ratio >= 0.18, i.e. for every frame of both drivers. This pair puts
 * them together at 0.14..0.94 with no clamping at either end and keeps headroom
 * under the avatar banks (0.05..0.12).
 */
declare const BROW_NEUTRAL = 0.15;
declare const BROW_DIVISOR = 0.24;
declare const G_HEAD = 0;
declare const G_MOUTH = 1;
declare const G_EYES = 2;
declare const G_BROWS = 3;
declare const G_BODY = 4;
declare const G_HAND_L = 5;
declare const G_HAND_R = 6;
declare const G_RESERVED = 7;
declare const GROUP_NAMES: readonly ["HEAD", "MOUTH", "EYES", "BROWS", "BODY", "HAND_L", "HAND_R", "RESERVED"];
declare const FACE_GROUPS: number;
declare const POSE_GROUPS: number;
declare const DIM_NAMES: string[];
declare const DIM_INDEX: Record<string, number>;
declare const DIM_GROUP: Int32Array;
declare const WEIGHTS: Float64Array;
declare const RETARGET: boolean[];
/** Neutral pose ("hands down", face level, body centred). Non-mirrored: the
 * subject's LEFT hand appears on image-RIGHT (+x). */
declare const NEUTRAL: Float64Array;
/** Negate lateral dims, swap L/R pairs. */
declare const MIRROR_NEGATE: number[];
declare const MIRROR_SWAP: [number, number][];
declare const F_NOSE_TIP = 1;
declare const F_CHEEK_R = 234;
declare const F_CHEEK_L = 454;
declare const F_EYE_R: [number, number];
declare const F_EYE_L: [number, number];
declare const F_EYE_R_LIDS: [number, number][];
declare const F_EYE_L_LIDS: [number, number][];
declare const F_IRIS_R = 468;
declare const F_IRIS_L = 473;
declare const F_LIP_PAIRS: [number, number][];
declare const F_MOUTH_CORNERS: [number, number];
declare const F_BROW_R = 105;
declare const F_BROW_L = 334;
declare const P_NOSE = 0;
declare const P_EYE_L = 2;
declare const P_EYE_R = 5;
declare const P_EAR_L = 7;
declare const P_EAR_R = 8;
declare const P_SHOULDER_L = 11;
declare const P_SHOULDER_R = 12;
declare const P_ELBOW_L = 13;
declare const P_ELBOW_R = 14;
declare const P_WRIST_L = 15;
declare const P_WRIST_R = 16;
declare const H_WRIST = 0;
declare const H_MCP_MID = 9;
declare const H_TIPS: [number, number, number, number];
declare const BLENDSHAPE_NAMES: readonly ["jawOpen", "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight", "mouthPucker", "mouthFunnel", "eyeWideLeft", "eyeWideRight", "browInnerUp", "browDownLeft", "browDownRight"];
/** Flat row-major landmarks: `[x0,y0,z0, x1,y1,z1, ...]` (stride 3) or with a
 * trailing visibility column for pose (stride 4).
 *
 * Any numeric TypedArray is accepted, not just `Float64Array`: a capture worker
 * posting landmarks across `postMessage` normally allocates `Float32Array`
 * (half the bytes, transferable), and that buffer must take the flat path. */
type FlatLandmarks = Float64Array | Float32Array | ArrayLike<number>;
/** MediaPipe-JS landmark point shape. */
interface LandmarkPoint {
    x: number;
    y: number;
    z?: number;
    visibility?: number;
}
type Landmarks = FlatLandmarks | ReadonlyArray<LandmarkPoint>;
declare function blank(): [Float64Array, number];
declare function applyMirror(values: Float64Array, mask: number): [Float64Array, number];
/**
 * Build a PoseDescriptor v1 from generic landmark arrays.
 *
 * @param face image-normalised face landmarks (>=468 points), or null
 * @param blend `{blendshapeName: score}`, or null
 * @param pose image-normalised pose landmarks (33 points), or null
 * @param hands 0..2 hand landmark sets, or null
 * @param mirror self-view webcam: negate lateral dims + swap L/R groups
 * @returns `[values (48 floats, float32 precision), mask]`
 */
declare function computeDescriptor(face?: Landmarks | null, blend?: Record<string, number> | null, pose?: Landmarks | null, hands?: (Landmarks | null | undefined)[] | null, mirror?: boolean): [Float64Array, number];
/** Per-dim 0/1 vector of active dims for a group mask. */
declare function groupVector(mask: number): Float64Array;
/** Approximate (yaw, pitch, roll) in degrees for HUDs / reports. */
declare function headDegrees(values: ArrayLike<number>): [number, number, number];

/**
 * One-Euro filter (Casiez et al., CHI 2012), vectorised over a descriptor.
 *
 * 1:1 port of `AniaAPP/src/ania_player/plugins/mocap_webcam/one_euro.py`.
 *
 * Per-group tuning (min_cutoff Hz, beta): HEAD 1.0/0.3, MOUTH 2.5/1.0, EYES 3.0/1.0
 * (blinks are fast), BROWS 1.5/0.5, BODY 0.8/0.2, HANDS 1.2/0.5, d_cutoff 1.0
 * everywhere. Dims absent from the live mask are not updated (their state is
 * frozen), so a hand that reappears does not "slide in" from a stale value.
 */
declare const GROUP_PARAMS: Record<number, [number, number]>;
declare const MIN_DT_MS = 10;
declare const MAX_DT_MS = 200;
declare class OneEuroVector {
    readonly minCutoff: Float64Array;
    readonly beta: Float64Array;
    readonly dCutoff: number;
    readonly n: number;
    private xHat;
    private dxHat;
    private initialised;
    private tPrev;
    constructor(minCutoff?: ArrayLike<number>, beta?: ArrayLike<number>, dCutoff?: number, n?: number);
    reset(): void;
    /** Filter sample `x` at time `tMs`. `active` = per-dim 0/1 (or null/undefined = all). */
    filter(tMs: number, x: ArrayLike<number>, active?: ArrayLike<number> | null): Float64Array;
    filterMasked(tMs: number, x: ArrayLike<number>, mask: number): Float64Array;
}

/**
 * MotionMatcher — deterministic frame selection for a frame-bank avatar.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/matcher.py`.
 * See that file's docstring and `wiki/concepts/ania-2-0-pose-descriptor-and-motion-graph.md`
 * for the full spec (cost space, modes, teleport gate, etc). Pure module: no DOM,
 * no wall clock (time is injected), no RNG — identical semantics to the Python are
 * pinned by the parity fixtures under `AniaAPP/tests/fixtures/mocap`.
 */

/**
 * §6 rule 4 ("never exceed the bank's own head range by more than 30 %"): the
 * retarget clamp is ±10 % of the span for every dim and ±30 % for the two head angles.
 */
declare const RETARGET_OVERSHOOT: Float64Array;
/** §4.5 expression hold — one-sided dims only; blinks, head, body and hands must be fast. */
declare const HOLD_DIMS: readonly number[];
/** Held only under `mouth_policy = "mocap"` (the camera owns the mouth). */
declare const HOLD_DIM_MOUTH_OPEN: number;
/** Dims the ARTICULATE sub-state amplifies / attenuates. */
declare const ARTICULATE_MOUTH_DIMS: readonly number[];
declare const ARTICULATE_HEAD_DIMS: readonly number[];
/** Head bins for the blink search — the same edges `coverage.json` uses. */
declare const BLINK_YAW_EDGES: readonly number[];
declare const BLINK_PITCH_EDGES: readonly number[];
declare const MODE_LIVE = "LIVE";
declare const MODE_DECAY = "DECAY";
declare const MODE_IDLE = "IDLE";
declare const SEQ_IDLE = 0;
declare const SEQ_TALK = 1;
declare const SEQ_OTHER = 2;
declare const KIND_KNN = 0;
declare const KIND_SUCC = 1;
declare const KIND_PRED = 2;
declare const KIND_HUB = 3;
declare class MatcherError extends Error {
    constructor(message: string);
}
interface StepResult {
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
interface MatcherOptions {
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
    blink_event: boolean;
    blink_threshold: number;
    /** What counts as "eye closed" in the bank. */
    blink_frame_threshold: number;
    blink_refractory_ms: number;
    blink_hold_ticks: number;
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
declare const DEFAULT_MATCHER_OPTIONS: MatcherOptions;
/** `ania.poses` bank (`poses.json`), as consumed by {@link MotionMatcher}. */
interface PosesBank {
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
        reach?: {
            lo?: ArrayLike<number>;
            hi?: ArrayLike<number>;
        } | null;
    };
    restFrame?: number;
    seq?: {
        name: string;
        low: number;
        high: number;
    }[];
    frameSeq?: ArrayLike<number>;
    cuts?: ArrayLike<number>;
    [key: string]: unknown;
}
/** `motion_graph.json` CSR, as consumed by {@link MotionMatcher}. */
interface MotionGraph {
    offsets: ArrayLike<number>;
    to: ArrayLike<number>;
    cost: ArrayLike<number>;
    kind?: ArrayLike<number>;
    restFrame?: number;
    [key: string]: unknown;
}
/** Bundle passed to `AnimationController.configureMocap`. */
interface MocapIndex {
    poses: PosesBank;
    motionGraph?: MotionGraph | null;
    options?: Partial<MatcherOptions>;
}
/** Wire message pushed via `AnimationController.pushPose`. */
interface PoseDescriptorMessage {
    v: 1;
    t: number;
    mask: number;
    norm?: 'raw' | 'cal';
    d: ArrayLike<number>;
}
declare class MotionMatcher {
    readonly opt: MatcherOptions;
    readonly N: number;
    private readonly F;
    private readonly Vmat;
    private readonly dimValid;
    private readonly weights;
    private readonly neutral;
    private readonly p05;
    private readonly p95;
    /** Per-dim multiplier applied to `WEIGHTS` before scoring (reaction levels §2.1). */
    readonly dimGain: Float64Array;
    /** `ranges.reach.lo` (or p05 when the bank carries no reach). */
    readonly reachLo: Float64Array;
    /** `ranges.reach.hi` (or p95 when the bank carries no reach). */
    readonly reachHi: Float64Array;
    /** Whether the bank actually carried a `ranges.reach` block. */
    readonly hasReach: boolean;
    private restFrame;
    private readonly seqOf;
    private readonly seqKindOf;
    /** 1 where the frame sits in a sequence the creator authored (idle/talk/action). */
    private readonly seqLegacyOf;
    /** 1 where the frame may be shown at all (`frame_pool` + `excluded_ranges`). */
    readonly allowed: Uint8Array;
    private readonly kindIndex;
    private readonly cutAfter;
    private readonly offsets;
    private readonly to;
    private readonly cost;
    private readonly edgeCost;
    private oneEuro;
    private xHat;
    private maskLive;
    private lastPoseAt;
    private lastStepAt;
    private talking;
    private envelope;
    private intensity;
    private recent;
    private runTicks;
    private dwellTicks;
    private lastTeleportAt;
    private idleTicks;
    private tick;
    private lastS;
    private lastDen;
    private lastGlobal;
    private denCacheMask;
    private denCache;
    private emaEBest;
    /** Visual cost of the transition actually taken on the last `step` (§4.2 crossfade input). */
    lastTransitionCost: number;
    /** Whether the last `step` was running the §4.4 idle micro-motion. */
    breathingActive: boolean;
    private silenceSince;
    private mouthPolicyEff;
    /**
     * Which policy actually owned the mouth on the last step (`audio` | `mocap`) — the
     * §4.3 handover as it resolved, not as it was configured. Read by the parity fixture,
     * which records it per tick, and by the HUD.
     *
     * Distinct from {@link mouthSource}, which answers "did the AVATAR's audio or the
     * user's CAMERA supply the value" and is spelled `audio` | `camera`.
     */
    get mouthPolicy(): 'audio' | 'mocap';
    private holdPeak;
    private holdT;
    private holdInit;
    /** Frames of this bank whose eyes are closed, and their head bins. */
    private readonly blinkFrames;
    private readonly yawBin;
    private readonly pitchBin;
    /** Optional per-frame openness (the legacy lip-sync map), NaN where unknown. */
    private openness;
    private hasOpenness;
    /** Wall-clock-free blink state. */
    lastBlinkAt: number;
    blinkEvents: number;
    private blinkPrev;
    private blinkHold;
    /** ARTICULATE state. */
    articulating: boolean;
    articulateUntil: number;
    micOpenness: number | null;
    /** When the last mic sample was pushed, or `null` if the caller never timestamps. */
    private micPushedAt;
    private mouthHist;
    constructor(poses: PosesBank, graph?: MotionGraph | null, options?: Partial<MatcherOptions>, oneEuro?: OneEuroVector | null);
    /**
     * Adopt the legacy lip-sync openness map (`AnimationController.buildOpennessMap`) as
     * the primary mouth measure of the ARTICULATE state, so the camera path picks the same
     * frames the audio path would instead of re-deriving "openness" from the descriptor's
     * MAR. Indexed relative to `talkLow`, exactly as the player stores it.
     */
    setOpennessMap(opennessMap: ArrayLike<number> | null | undefined, talkLow: number): void;
    /** The idle frame nearest the neutral pose — the DECAY-mode hub target. */
    getRestFrame(): number;
    reset(): void;
    pushPose(tMs: number, mask: number, values: ArrayLike<number>, norm?: 'raw' | 'cal'): void;
    setAudio(talking: boolean, envelope: number, intensity?: number): void;
    setMouthPolicy(policy: string): void;
    hasFreshPose(nowMs: number): boolean;
    private holdDims;
    /**
     * Hold a one-sided expression at its peak for `hold_ms`, then release it linearly
     * over `hold_release_ms`. Blinks, head, body and hands are exempt — they must be
     * fast. Runs on the filtered target, before the matcher, so every runtime gets the
     * behaviour from one place.
     */
    private applyHold;
    /**
     * The eye-closed frame to jump to: prefer one in the same head bin, else the cheapest
     * transition from the graph, then by pose-cost, then by index.
     */
    private pickBlinkFrame;
    /**
     * Frame to force this tick because of a blink, or `null`. Updates the edge state on
     * every tick so the detector cannot latch.
     */
    private blinkStep;
    /**
     * 0..1 speech envelope of the USER's microphone (`mouth_blend` mic/hybrid).
     *
     * The camera keeps smile / width / pucker; the mic only owns how OPEN the mouth is,
     * which is the one channel a webcam at 12 Hz cannot resolve fast enough to look like
     * speech. `null` = no mic.
     */
    setMicOpenness(openness: number | null | undefined, atMs?: number): void;
    /**
     * The mouth-open target the ARTICULATE search aims at: by default the louder of the mic
     * envelope and the attenuated camera opening, so a user who is speaking drives the
     * mouth even when the webcam is too slow to catch the articulation.
     */
    mouthOpenTarget(): number;
    /**
     * Speech-like activity on the mouth target keeps the sub-state armed for
     * `articulate_hold_ms` after the last sign of it.
     */
    private articulateActive;
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
    private articulatePick;
    /**
     * `audio` while the voice owns the mouth, `mocap` when the camera does.
     *
     * `mouth_policy = "auto"` follows the audio with hysteresis: talking → audio
     * immediately; silence → wait `mouth_handover_ms` and only then hand the mouth to
     * the camera, and any talking inside that window cancels the pending switch.
     * `talking_forces_audio` applies §6 rule 1 to the static `mocap` policy too (level
     * `mirror`): no camera mouth while audio is playing.
     */
    private effectiveMouthPolicy;
    /**
     * What is driving the mouth right now, in the words the HUD uses: `"audio"` (the
     * avatar's own voice / lip-sync) or `"camera"` (the user's mouth). Follows the
     * effective policy, so it flips back to `audio` the instant the avatar starts
     * speaking at every level, including `mirror` (§6 rule 1).
     */
    get mouthSource(): 'audio' | 'camera';
    private modeAt;
    private isNatural;
    private edgesOf;
    private transition;
    private scores;
    step(nowMs: number, currentFrame: number, isCached?: (j: number) => boolean): StepResult;
    /** One bank frame's own descriptor row (the affine head-region input). */
    frameDescriptor(frame: number): Float64Array;
    /** The live (filtered, retargeted) descriptor target. */
    getTarget(): Float64Array;
    /** The live group mask of the last pushed pose. */
    getLiveMask(): number;
    /** The bank's neutral pose at one dim (the DECAY target). */
    neutralAt(dim: number): number;
    /** The bank's p05/p95 at one dim (the legacy, non-reach retarget range). */
    p05At(dim: number): number;
    p95At(dim: number): number;
    /** Swap (or drop, with `null`) the One-Euro filter — for tests that isolate the hold. */
    setOneEuro(filter: OneEuroVector | null): void;
    /** Live target minus the chosen frame's descriptor (for the affine warp). */
    residual(frame: number): Float64Array;
    /**
     * Boolean per frame: may the matcher show it? (`MatcherOptions.frame_pool`)
     *
     * `all` (the legacy-parity default) allows everything. `legacy` allows only the
     * sequences the creator authored and drops every explicitly excluded range (the
     * manifest's `video.ania2.coverage` block, handed in by the host). A policy that would
     * empty the bank is ignored — a frozen avatar is worse than a wrong frame.
     */
    private buildPool;
    /** How many frames the current pool leaves reachable (HUD / stats). */
    get poolSize(): number;
    /**
     * Visual cost of the step i -> j: 0 for a natural step, the graph's edge cost for a
     * cheap transition, `c_jump` for a cut nothing sanctions. Public because the lab
     * scores whole runs with it (`transitionCostMean`), including runs this matcher did
     * not choose — the legacy player's own playback, for instance.
     */
    transitionCost(i: number, j: number): number;
    /**
     * True exactly once per blink of the USER, refractory-gated. Reads the filtered
     * target, so it costs nothing extra and cannot latch (the edge state is updated on
     * every call, whether or not the event fires).
     */
    blinkEdge(nowMs: number): boolean;
    /**
     * The eye-closed frame to detour to: inside the SAME sequence as the cursor and no
     * further than `maxDelta` frames away, nearest first (ties by index).
     *
     * Both constraints exist so the detour is invisible: neighbouring frames of one
     * sequence differ by a blink and little else, so the cut in and the cut back read as
     * the blink itself rather than as a jump.
     */
    blinkFrameNear(i: number, maxDelta?: number): number | null;
    /**
     * Of the cycler's own start positions, the one whose smile and head yaw sit closest to
     * the user right now. Deterministic (ties by index), pool-aware, and never invents a
     * frame: it only reorders a choice the legacy engine was about to make at random,
     * which is the one moment a cut is already happening.
     */
    startPointScore(candidates: ArrayLike<number> | null | undefined): number | null;
    /**
     * 0..1 openness of the USER's microphone for the legacy talk path, or `null`.
     *
     * `null` means the mic has nothing to say — none was ever pushed, the caller pushed
     * `null`, or the last sample is older than `staleMs`. A stale sample must not keep
     * driving the mouth: a capture that dies mid-word would leave the avatar frozen with
     * its mouth open.
     */
    micOpennessAt_(nowMs: number, staleMs?: number): number | null;
    /** RMS pose error of x vs one frame under a live mask (E units). */
    poseError(x: ArrayLike<number>, mask: number, frame: number): number;
}

declare const GRAY = 32;
declare const ALPHA = 32;
declare const EDGE = 16;
declare const W_GRAY = 0.5;
declare const W_ALPHA = 0.3;
declare const W_EDGE = 0.2;
declare const SIG_LEN: number;
/** One frame's pixels. `ImageData` satisfies this shape as-is. */
interface FramePixels {
    /** RGBA bytes, row-major, 4 per pixel. `ImageData.data` fits here. */
    data?: Uint8ClampedArray | Uint8Array | number[];
    /** Alias accepted for callers that name the buffer `rgba`. */
    rgba?: Uint8ClampedArray | Uint8Array | number[];
    width: number;
    height: number;
}
interface MotionGraphOptions {
    /** Sequence id per frame (from `frameSeq`). Default: every frame in sequence 0. */
    frameSeq?: ArrayLike<number>;
    /** kNN edges per frame. Default 8. */
    k?: number;
    /** kNN edges above this normalised cost are dropped. Default 6. */
    edgeCostMax?: number;
    /** Costs are clipped here. Default 20. */
    costClip?: number;
    /** Force the rest frame; `null`/omitted derives it from motion energy. */
    restFrame?: number | null;
    /** Successor cost above this splits the sequence (a cut). Default 6. */
    cutThreshold?: number;
    /** 1 = single-frame distance, 2 = two-frame window (default). */
    window?: number;
    /** Copied into the output when given (the Python indexer adds it separately). */
    contentHash?: string;
    /** Called every `progressEvery` frames while signatures are computed. */
    onProgress?: (done: number, total: number) => void;
    progressEvery?: number;
}
/**
 * Python's `round(x, nd)`: round-half-to-EVEN on the exact binary value, then
 * back to the nearest double. `Math.round(x * 100) / 100` is not the same
 * function (it rounds halves up and re-introduces float error), and `toFixed`
 * rounds halves away from zero. Values such as 0.0625 -> 0.062 (not 0.063)
 * are exactly representable and do occur.
 */
declare function pyRound(x: number, nd: number): number;
/**
 * Pillow's `Image.resize(..., Image.Resampling.BOX)` for an 8-bit RGBA image,
 * reproduced byte for byte: premultiply (RGBA -> RGBa), horizontal pass,
 * vertical pass, unpremultiply (RGBa -> RGBA). Identical sizes short-circuit to
 * a copy exactly like Pillow does — which is why a 32x32 source survives the
 * premultiply round trip untouched.
 */
declare function boxResizeRgba(src: Uint8ClampedArray | Uint8Array | number[], srcW: number, srcH: number, outW: number, outH: number): Uint8ClampedArray;
/**
 * Visual signature of one RGBA frame -> float32[SIG_LEN]. Every arithmetic step
 * is float32 (Math.fround) because numpy runs this whole pipeline in float32.
 */
declare function signature(frame: FramePixels): Float32Array;
/** `||s_i - s_j||^2 / 1024` for all pairs (float64, symmetric, zero diagonal). */
declare function allPairsSq(sigs: Float32Array[], dim?: number): Float64Array;
/**
 * Build the CSR motion graph from the all-pairs visual distance `V`
 * (row-major n x n). Mirrors `graph.build_graph`.
 */
declare function buildGraphFromDistances(V: Float64Array, n: number, frameSeq: ArrayLike<number>, opts?: MotionGraphOptions): MotionGraph;
/**
 * Frames -> `motion_graph.json`. The whole offline graph step, in the browser.
 *
 * @param frames RGBA pixel buffers (`ImageData` works directly).
 * @param opts   see {@link MotionGraphOptions}.
 */
declare function buildMotionGraph(frames: FramePixels[], opts?: MotionGraphOptions): MotionGraph;

declare const SCHEMA_POSES = "ania.poses";
declare const SCHEMA_COVERAGE = "ania.coverage";
/** `dimValid` when the caller does not supply one: the 40 used dims. */
declare const DIM_VALID_DEFAULT: number[];
/** Marginal target bins (dim -> edges, weight). "count >= 3" per bin = covered. */
declare const TARGET_BINS: [string, number[], number][];
declare const GAP_PRESET: Record<string, string>;
declare const PRESETS: string[];
interface Sequence {
    name: string;
    low: number;
    high: number;
}
interface CoverageGap {
    dim: string;
    bin: number;
    label: string;
    need: number;
    have: number;
    preset: string;
}
interface Coverage {
    schema: string;
    version: number;
    contentHash: string;
    descriptorVersion: number;
    frameCount: number;
    indexedFrames: number;
    meanConfidence: number;
    source: string;
    bins: Record<string, {
        edges: number[];
        counts: number[];
    }>;
    headYawPitch: {
        yawEdges: number[];
        pitchEdges: number[];
        counts: number[];
    };
    hands: {
        noneVisible: number;
        leftOnly: number;
        rightOnly: number;
        both: number;
    };
    gaps: CoverageGap[];
    coverageScore: number;
    calibrationPresets: string[];
}
/**
 * Build the `seq` list: idle/talk ranges, actions, then contiguous leftovers as
 * orphans. Mirrors `index.sequences_from_ranges`.
 */
declare function sequencesFromRanges(frameCount: number, idle: [number, number], talk: [number, number], actions?: [string, number, number][]): Sequence[];
/** Per-frame sequence index. Mirrors `index.frame_seq`. */
declare function frameSeq(frameCount: number, seqs: Sequence[]): Int32Array;
interface PosesIndexOptions {
    /** Per-frame confidence. Default: 1.0 for every frame. */
    confidence?: ArrayLike<number>;
    contentHash?: string;
    generator?: Record<string, unknown>;
    source?: string;
    /** Per-dim validity flags. Default {@link DIM_VALID_DEFAULT}. */
    dimValid?: ArrayLike<number>;
    cuts?: ArrayLike<number>;
    motionEnergy?: ArrayLike<number>;
    /** Emitted dimension count. Default 40 (`NUSED`). */
    dims?: number;
    /**
     * When given, `ranges.reach` is attached from these coverage bins exactly like
     * `index.attach_reach`. Omit it and the output is byte-identical to the pre-levels
     * `build_poses` (which is why the Python reference attaches the reach in a second
     * pass, after `build_coverage`).
     */
    coverage?: Coverage | null;
    /**
     * `ranges.reach` bin threshold. A bin holding at least this many frames is a pose
     * the bank can hold long enough to be seen. Default 3.
     */
    reachMinCount?: number;
}
/**
 * Descriptors + masks + sequences -> the `poses.json` object.
 * Mirrors `index.build_poses`.
 */
declare function buildPosesIndex(descriptors: ArrayLike<number>[], masks: ArrayLike<number>, seq: Sequence[], opts?: PosesIndexOptions): PosesBank;
/**
 * `ranges.reach` — the range each dim can actually be *shown* at, not the p05/p95 of
 * the whole index. Mirrors `index.build_reach`.
 *
 * The p05/p95 pair answers "where do most frames sit", which is the wrong question for
 * a retarget: on `Nanda3_v2` the 127 appended wide-yaw frames are 13 % of 959, so the
 * p05/p95 of the bank squashes a user turning ±40° into ±6° and the deep frames are
 * never asked for. `reach` answers "where can this bank *go*": the union of the
 * coverage bins that hold at least `minCount` frames, i.e. the poses the bank can hold
 * long enough to be seen, clipped to the values actually present so a bin edge never
 * promises a frame that does not exist.
 *
 * Falls back to p05/p95 for a dim with no coverage bins, or with fewer than two filled
 * bins (one filled bin carries no range information — its edges are an artefact of the
 * binning, not a measurement). Returns `{lo, hi}` covering every emitted dim.
 */
declare function buildReach(poses: PosesBank, coverage: Coverage | null | undefined, minCount?: number): {
    lo: number[];
    hi: number[];
};
/** Put {@link buildReach} under `poses.ranges.reach` (in place) and return `poses`. */
declare function attachReach(poses: PosesBank, coverage: Coverage | null | undefined, minCount?: number): PosesBank;
/**
 * `poses.json` -> `coverage.json`: which marginal bins the bank actually covers,
 * which gaps need a calibration preset, and the overall coverage score.
 * Mirrors `index.build_coverage`.
 */
declare function buildCoverage(poses: PosesBank, minCount?: number): Coverage;

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

declare const LEVEL_OFF = "off";
declare const LEVEL_PRESENCE = "presence";
declare const LEVEL_EXPRESSIVE = "expressive";
declare const LEVEL_MIRROR = "mirror";
declare const LEVEL_ORDER: readonly ["off", "presence", "expressive", "mirror"];
type MocapLevel = (typeof LEVEL_ORDER)[number];
type CrossfadeMode = 'auto' | 'on' | 'off';
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
declare const ENGINE_LEGACY = "legacy";
declare const ENGINE_MATCHER = "matcher";
type EngineMode = 'legacy' | 'matcher';
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
declare const FRAME_POOL_LEGACY = "legacy";
declare const FRAME_POOL_ALL = "all";
declare const FRAME_POOLS: readonly ["legacy", "all"];
type FramePool = (typeof FRAME_POOLS)[number];
/**
 * §4.7 — `presence` blink detour: how far from the cursor an eye-closed frame may sit
 * and still be a cut nobody sees. Frames this close inside one sequence are
 * near-identical, so the cut in and the cut back read as the blink itself.
 */
declare const BLINK_DETOUR_MAX_DELTA = 30;
declare const BLINK_DETOUR_TICKS = 2;
/**
 * §4.8 — the user's microphone drives the LEGACY talk path (open fast, close slow, so an
 * intra-sentence pause does not drop the avatar back to idle).
 */
declare const MIC_TALK_THRESHOLD = 0.12;
declare const MIC_TALK_OPEN_TICKS = 1;
declare const MIC_TALK_CLOSE_TICKS = 8;
/**
 * The brow mapping was a constant (+1.00 on 100 % of frames of both drivers) up to
 * revision 1; §5.1's driver-side gate forced `caps.brows = 0` while that was true.
 * `descriptor.BROW_MAPPING_VERSION` is bumped by the re-fit, which lifts the gate.
 */
declare const BROW_GATE_MIN_MAPPING_VERSION = 2;
declare const INTENSITY_MIN = 0.5;
declare const INTENSITY_MAX = 1.5;
declare const SMOOTHING_MIN = 0.5;
declare const SMOOTHING_MAX = 2;
declare const RETARGET_GAIN_MIN = 0.4;
declare const RETARGET_GAIN_MAX = 1.9;
declare const CROSSFADE_MODES: readonly CrossfadeMode[];
/**
 * Where the user's mouth-OPEN value comes from once the level hands the mouth over.
 * `audio` means it never does (the avatar's own voice keeps it) — that is `presence`.
 */
declare const MOUTH_SOURCES: readonly ["audio", "camera", "mic", "hybrid"];
type MouthSource = (typeof MOUTH_SOURCES)[number];
/**
 * Live feedback 2026-09-05 ("acho que nem meu mic tá sendo usado"): a webcam delivers
 * 11-13 descriptors/s in the running player, which cannot resolve syllables, so the
 * levels that hand the mouth over default to the microphone blended with the camera.
 */
declare const LEVEL_MOUTH_SOURCE: Record<string, MouthSource>;
declare const CROSSFADE_COST = 6;
declare const CROSSFADE_MS = 120;
declare const CROSSFADE_TICKS = 3;
declare const MOUTH_HANDOVER_MS = 250;
declare const BREATHING_DWELL_TICKS = 25;
declare const BREATHING_COST_BONUS = 0.004;
declare const HEAD_YAW_DEG_PER_UNIT = 30;
declare const STRINGS: Record<string, string>;
/** UI copy (§1). */
declare const LEVEL_UI: Record<string, {
    name: string;
    subtitle: string;
}>;
interface LevelGain {
    head: number;
    mouth: number;
    blink: number;
    eyes: number;
    brows: number;
    body: number;
    hands: number;
}
interface LevelComfortDefaults {
    intensity: number;
    smoothing: number;
    crossfade: CrossfadeMode;
    breathing: boolean;
    mirror: boolean;
}
interface LevelAffine {
    base_strength: number;
    max_translate_frac: number;
    max_rotate_deg: number;
    max_scale_dev: number;
    /** Head-only mode caps (`paramsForHead`): much tighter, because a head that slides
     * away from a static body opens a seam at the collar. */
    head_max_translate_frac: number;
    head_max_rotate_deg: number;
}
interface LevelSpec {
    ui: {
        name: string;
        subtitle: string;
    };
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
declare const LEVELS: Record<string, LevelSpec>;
/** §5.2 — caps that block a level outright vs caps that only warn. */
declare const BLOCKERS: Record<string, readonly string[]>;
declare const WARNERS: Record<string, readonly string[]>;
/** Channel labels for the "olhos · sorriso · boca" line (§2.6). */
declare const CHANNEL_LABEL: Record<string, string>;
/** One i18n string from §5.4 with its placeholders filled. */
declare function text(key: string, kw?: Record<string, unknown>): string;
interface MocapCaps {
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
type CoverageLike = Coverage | {
    bins?: Record<string, {
        counts?: ArrayLike<number>;
        edges?: ArrayLike<number>;
    }>;
} | null | undefined;
/**
 * What this bank can physically show (§5.1). Pure; same thresholds in every port.
 *
 * `poses` is a parsed `poses.json`; `coverage` a parsed `coverage.json` (bins with
 * `count >= 3` are "filled"). Returns 0/1 caps plus a `metrics` block the UI needs
 * to word its sentences, and `blend` (renderer capability) defaulted to 1 — the
 * caller overwrites it at attach time.
 */
declare function probeCaps(poses: PosesBank | null | undefined, coverage?: CoverageLike, browMappingVersion?: number): MocapCaps;
/**
 * Per-dim multiplier applied to `WEIGHTS` (§2.1). MOUTH carries the *camera* gain;
 * while the audio owns the mouth the matcher zeroes the driver's contribution itself.
 */
declare function dimGainFor(level: string, caps: Partial<MocapCaps>): Float64Array;
/**
 * Per-dim One-Euro min-cutoff (§2.4). EYES is pinned at its base 3.0 Hz at every level
 * and for every slider position — a filtered blink is a lost blink.
 */
declare function oneEuroMinCutoff(level: string, smoothing?: number): Float64Array;
/**
 * §4.2 trigger, as a pure function so every port and the tests agree.
 *
 * A transition costs `>= CROSSFADE_COST` (6) when it is a visible jump — every
 * teleport included, whose `c_jump` is 8. `auto` blends wherever the renderer can;
 * `off` never; `on` blends but degrades to never on a renderer that cannot composite
 * (and then the teleport is not taken at all, see {@link resolveOptions}).
 */
declare function shouldCrossfade(transitionCost: number, crossfade: string, canBlend?: boolean): boolean;
/** `alpha(t) = clamp(t / min(120 ms, 3 ticks), 0, 1)` — the new frame's weight. */
declare function crossfadeAlpha(elapsedMs: number, durationMs?: number): number;
interface MocapComfort {
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
declare function defaultComfort(level: string): MocapComfort;
/** The wire form (§3.2): the six keys, in that order, lower-camel, no nesting. */
declare function serializeComfort(comfort: Partial<MocapComfort> | null | undefined): MocapComfort;
interface MocapWarning {
    key: string;
    text: string;
}
interface ResolvedAffine {
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
interface ResolvedOptions {
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
    ui?: {
        name: string;
        subtitle: string;
    };
}
/**
 * Comfort object + bank capabilities -> every knob, plus the pt-BR warnings.
 *
 * Never throws and never silently downgrades: when a level is blocked the result
 * carries the granted level, `blocked = true`, the requested level and a warning
 * naming the missing thing and the fix (§5.4).
 */
declare function resolveOptions(comfort: Partial<MocapComfort> | null | undefined, caps?: Partial<MocapCaps> | null): ResolvedOptions;
interface LevelCard {
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
declare function levelCards(caps?: Partial<MocapCaps> | null): LevelCard[];
/** Which piece of software picks the frame at this level (`ENGINE_*`). */
declare function engineOf(level: string): EngineMode;
/** This level's default candidate pool (`FRAME_POOL_*`). */
declare function framePoolOf(level: string): FramePool;
/** The subset of {@link resolveOptions} that `new MotionMatcher(..., options)` accepts. */
declare function matcherKwargs(resolved: ResolvedOptions): Partial<MatcherOptions>;
/**
 * Can the user's own mouth reach this level's avatar at all — by any route?
 *
 * True from `presence` up. At `presence` the route is NOT the matcher: the microphone
 * envelope is fed to the player's own lip-sync path (talk range + openness map), which is
 * the thing the user actually liked ("no Ania 1.0 é bonitão"). `expressive` and `mirror`
 * hand the mouth to the matcher instead — see {@link matcherCameraMouth}.
 */
declare function allowsCameraMouth(level: string): boolean;
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
declare function matcherCameraMouth(level: string): boolean;
/** Whether the level actually drives the avatar (everything but `off`). */
declare function levelActive(level: string): boolean;

/**
 * Residual 2-D affine warp — the "head move X/Y" trick applied to a frame bank.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/affine.py`.
 *
 * The matcher picks the nearest frame; the residual between the live descriptor and
 * that frame's descriptor (yaw, pitch, roll, body offset) is turned into a small
 * rotation / translation / scale of the frame. Even a bank with 3 head bins then
 * follows the user continuously instead of snapping.
 *
 * Gains are deliberately modest and clamped: this is a *residual*, not a puppet.
 * Pure module — no canvas, no DOM. {@link paramsFromResidual} produces the numbers;
 * the renderer applies them (see `AniaPlayer.renderFrame`).
 */
interface AffineGains {
    /** Fraction of width per descriptor unit (1.0 = ±30°). */
    yaw_px_per_unit: number;
    /** Fraction of height per unit. */
    pitch_px_per_unit: number;
    /** Degrees per unit (1.0 = 30°); < 1 keeps it subtle. */
    roll_deg_per_unit: number;
    pitch_scale_per_unit: number;
    body_x_frac: number;
    body_y_frac: number;
    max_translate_frac: number;
    max_rotate_deg: number;
    max_scale_dev: number;
    /** Rotate about the face region, not the image centre. */
    pivot_y_frac: number;
    breathe_hz: number;
    breathe_ty_frac: number;
    breathe_scale: number;
    head_max_translate_frac: number;
    head_max_rotate_deg: number;
}
declare const DEFAULT_AFFINE_GAINS: AffineGains;
interface AffineParams {
    /** Pixels. */
    tx: number;
    ty: number;
    rot_deg: number;
    scale: number;
    pivot: [number, number];
}
declare function isIdentity(p: AffineParams, eps?: number): boolean;
/**
 * Residual -> tx/ty/rot/scale, clamped by the level's caps.
 *
 * `breathingT` (seconds, derived from the matcher tick counter) adds the §4.4
 * micro-oscillation *before* the caps, so a breathing avatar still respects
 * `max_translate_frac` / `max_scale_dev` exactly.
 */
declare function paramsFromResidual(residual: ArrayLike<number>, width: number, height: number, gains?: Partial<AffineGains> | null, strength?: number, breathingT?: number | null): AffineParams;
/**
 * `resolveOptions().affine` -> {@link AffineGains} (caps only; the per-unit gains and
 * the pivot stay at their defaults at every level, see §2.5).
 */
declare function gainsFromOptions(affineOpts?: Partial<AffineGains> | null): AffineGains;
/** Half-width = 1.20 × cheek width. */
declare const HEAD_RX_PER_W = 1.2;
/** Half-height = 1.65 × cheek width. */
declare const HEAD_RY_PER_W = 1.65;
/** Ellipse centre sits below the eye line by 0.30 × cheek width. */
declare const HEAD_DROP_PER_W = 0.3;
/** Soft edge, fraction of the frame height (the neck line). */
declare const HEAD_FEATHER_FRAC = 0.08;
/** ...but never less than 12 % of the head's own height. */
declare const HEAD_FEATHER_MIN_OF_HEAD = 0.12;
/** Fallback when the frame carries no BODY group: the upper 45 % of the frame. */
declare const HEAD_FALLBACK: [number, number, number, number];
/** Feathered ellipse the residual warp is allowed to touch. Fractions of the frame. */
interface HeadRegion {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    feather: number;
}
declare function headRegionKey(r: HeadRegion, width: number, height: number): string;
/** Head ellipse of one bank frame, from its own headX/headY/faceScale (+ body) dims. */
declare function headRegionFromFrame(frameDesc: ArrayLike<number> | null | undefined, mask?: number, feather?: number): HeadRegion;
/**
 * Ramp width in units of the ellipse radius, at least {@link HEAD_FEATHER_MIN_OF_HEAD}
 * of the head's own height (the head is `2·ry` tall, so 12 % of it is 0.24 radii).
 */
declare function featherNorm(region: HeadRegion): number;
/**
 * Alpha of the head mask at one normalised point: 1 in the core of the head, ramping to
 * **exactly 0 on the ellipse boundary** — the neck line — and 0 everywhere outside it.
 *
 * The ramp points INWARD on purpose: an outward ramp would let a fraction of the warp
 * reach the collar, which is what made the neck look detached in the first live test.
 * With this mask no pixel outside the ellipse is touched at all, so the body is
 * byte-identical to the decoded frame.
 */
declare function regionAlphaAt(region: HeadRegion, xFrac: number, yFrac: number): number;
/**
 * `(h, w)` Float32 alpha map in [0, 1] — the exact Python `region_alpha` output, for
 * tests and for renderers that composite pixel-wise. The canvas path uses a radial
 * gradient instead (same ramp, no per-pixel JS).
 */
declare function regionAlpha(width: number, height: number, region: HeadRegion): Float32Array;
/**
 * Re-aim a full-frame residual at a head that has to stay attached to its body.
 *
 * Three changes, all of them the difference between "she turned her head" and "her head
 * slid off": the pivot moves to the **base of the neck** (bottom centre of the head
 * ellipse) so a rotation swings the chin instead of shearing the collar; the scale is
 * dropped to 1.0 (scaling the head alone changes head-to-body proportion, which reads as
 * a different person); and tx/ty/rot are re-clamped to the much tighter head caps.
 */
declare function paramsForHead(p: AffineParams, region: HeadRegion, width: number, height: number, gains?: Partial<AffineGains> | null): AffineParams;
/** Pixel bbox of the head ellipse plus a margin for the pixels the warp pulls in. */
declare function regionBox(width: number, height: number, region: HeadRegion, marginFrac?: number): [number, number, number, number];
/** Where a residual warp is allowed to act. */
type WarpRegion = 'head' | 'full';

/**
 * SmoothCut — the flagship of Ania 2.0, and the one part of it that has nothing to do
 * with a camera.
 *
 * The owner's verdict on what Ania 2.0 was for (2026-09-05):
 *
 *     "o maior problema do Ania 1 era a transição de talk para idle...
 *      o Ania 2 nasceu justamente pra resolver isso"
 *
 * The Ania 1.0 player cuts between sequences by index, not by image. When speech ends it
 * jumps from wherever the talk sweep happened to be to `idle_range_low` (or to a random
 * entry from `idle_start_positions`), and the two frames on either side of that cut have
 * no reason whatsoever to look alike. The mouth is open in one and shut in the next; the
 * head is turned one way and then the other. That is the pop everybody sees, and it fires
 * on every talk->idle, idle->talk, action exit and range wrap.
 *
 * The motion graph already knows what those cuts cost — it is a table of "these two
 * frames look alike enough to cut between, and here is how much it shows". So the fix is
 * not to invent new frames, it is to CHOOSE the entry frame the graph says is cheapest:
 *
 *   1. Pick the entry in the target range that minimises `c(current, candidate)`.
 *   2. If even the best entry is still a visible jump (`>= costThreshold`, the same 6 the
 *      crossfade trigger uses), look for a short BRIDGE — 1..`maxBridge` frames chained
 *      through the graph's own edges — and play it on the way in. A bridge is the
 *      avatar's own footage, so it reads as motion rather than as a dissolve.
 *   3. Only if no bridge exists does the renderer fall back to a <= 120 ms crossfade.
 *
 * Independence is the point of this module. It needs a `motionGraph` and nothing else:
 * no webcam, no pose bank, no descriptors, no `setMocapEnabled(true)`. A page that only
 * ever plays TTS gets every one of these cuts fixed. Without a graph every method is
 * inert and the caller keeps its own choice byte for byte, which is what keeps
 * `player-runtime/verify.mjs` frame-identical.
 *
 * Determinism is load-bearing: every ordering below breaks ties explicitly (cost, then
 * closeness to the author's own start points, then the lower index), because the three
 * runtimes and the Python reference all have to land on the same frame.
 */

/** A transition this expensive is a visible jump (the §4.2 crossfade trigger). */
declare const CUT_COST_THRESHOLD = 6;
/** Cost of a cut nothing in the graph sanctions — mirrors `MatcherOptions.c_jump`. */
declare const CUT_C_JUMP = 8;
/** Longest bridge the search will play, in frames. */
declare const CUT_MAX_BRIDGE = 3;
/** Hard ceiling on edge expansions per bridge search, so a dense graph cannot stall. */
declare const CUT_MAX_EXPANSIONS = 64;
/** Longest dissolve, when there is no bridge to play instead. */
declare const CUT_CROSSFADE_MS = 120;
/** Costs equal to this many decimal places count as a tie. */
declare const CUT_TIE_DECIMALS = 3;
/** A candidate within this much of the best cost is "just as smooth" (bias window). */
declare const CUT_BIAS_SLACK = 0.5;
/**
 * Ceiling on a signature-derived cost. `graph.build_graph` clips at this because a graph
 * only ever stores CHEAP edges; a cut between two ranges is nowhere near it, so the entry
 * ranking is deliberately left UNCLIPPED - clipping it would make every candidate tie at
 * 20 and the search would pick by index, which is exactly the bug that made the first
 * bench report "0 % improvement" while the picture plainly improved.
 */
declare const CUT_COST_CLIP = 20;
interface SmoothCutOptions {
    /**
     * `true` cuts through the graph whenever one is loaded, `false` never does, `'auto'`
     * is `true` when a graph is present — the same thing, spelled the way a config file
     * spells it.
     */
    enabled: boolean | 'auto';
    /** Longest bridge to play, in frames. 0 disables bridging (crossfade only). */
    maxBridge: number;
    /** Longest dissolve when no bridge is found. */
    crossfadeMs: number;
    /** Above this cost the cut is visible and wants a bridge or a dissolve. */
    costThreshold: number;
    /** Cost of an unsanctioned cut. */
    cJump: number;
    /** Ceiling on edge expansions per bridge search. */
    maxExpansions: number;
    /** Costs equal to this many decimal places are a tie (Python `tie_decimals`). */
    tieDecimals: number;
    /** How far above the best cost the expression bias may reach (`bias_slack`). */
    biasSlack: number;
}
declare const DEFAULT_SMOOTH_CUT_OPTIONS: SmoothCutOptions;
/** What the controller should do for one cut. */
interface CutPlan {
    /** The frame to enter the target range on. */
    frame: number;
    /** The graph cost of the transition actually taken (the worst step of a bridge). */
    cost: number;
    /** Cost of the best DIRECT entry, before any bridge. */
    directCost: number;
    /** What the legacy random start point would have cost — the before/after number. */
    baselineCost: number;
    /** Frames to play on the way in, in order. Empty when the entry is cheap enough. */
    bridge: number[];
    /** Whether the renderer should dissolve — only when nothing cheaper was available. */
    crossfade: boolean;
    /** `false` when this module had no opinion and `frame` is the caller's own fallback. */
    planned: boolean;
}
/** `(from, to) -> visual cost`. Injected so a host with a pose bank can share the
 * matcher's own notion of a natural step, which knows where the sequence cuts are. */
type CutCostFn = (from: number, to: number) => number;
/**
 * A second opinion over the candidates that are all equally smooth. Returns one of them,
 * or `null` to keep the cheapest. This is the seam Sutil's smile/head-yaw hint plugs into.
 */
type CutBiasFn = (candidates: number[]) => number | null;
declare class SmoothCut {
    private offsets;
    private to;
    private edgeCost;
    /** `from * N + to -> cost`, for the O(1) cost lookup the entry scan needs. */
    private edgeIndex;
    private n;
    private allowed;
    private costFn;
    /** `frameCount x SIG_LEN`, row-major float64. `null` until signatures are built. */
    private sig;
    /** Row self-dot products, so a distance is one dot product instead of a subtraction. */
    private sigSq;
    /** "the frame that naturally follows i" - the two-frame window the graph metric uses. */
    private nxt;
    /**
     * The median distance between naturally consecutive frames: "one playback step". Every
     * signature cost is divided by it, which is what makes `c = 1` mean the same thing here
     * as it does in `motion_graph.json`. Leaving this at a placeholder 1.0 makes every cost
     * ~10^5 times too small and silently disables the bridge and the bias window.
     */
    private succMedian;
    private hasSidecarMedian;
    readonly opt: SmoothCutOptions;
    /** Last plan's cost and bridge, for `getMocapDebug()`. */
    lastCutCost: number;
    bridgeFrames: number;
    cuts: number;
    bridges: number;
    crossfades: number;
    constructor(graph?: MotionGraph | null, options?: Partial<SmoothCutOptions>);
    setGraph(graph: MotionGraph | null): void;
    /**
     * Which frame naturally follows each one. Without sequence info the bank is one run, so
     * it is `i + 1` and the last frame follows itself. Defaulting this to `i` instead leaves
     * the successor distances empty and the median at its placeholder, which is the failure
     * mode the Python reference calls out by name.
     */
    private ensureNext;
    /**
     * Tell the planner where the sequences end, so the two-frame window does not step across
     * a cut. `seqOf[i]` is any per-frame sequence id (the matcher's `seqOf` does fine).
     */
    setSequences(seqOf: ArrayLike<number> | null): void;
    /** Whether signature costs are available (the sidecar-free ranking). */
    get ready(): boolean;
    /**
     * Adopt a precomputed signature matrix (`frameCount x SIG_LEN`, row-major).
     *
     * This is what makes SmoothCut work on an avatar nobody ever indexed: the signatures
     * come from the decoded frames themselves, so no `motion_graph.json` is required. A
     * sidecar, when there is one, only improves the BRIDGE (it supplies the authored edges)
     * and pins `succCostMedian` exactly.
     */
    setSignatures(rows: ArrayLike<number> | null, frameCount?: number): void;
    /**
     * Decode every frame once and keep its signature. `getFrame` returns the RGBA pixels of
     * one frame, or `null` when it cannot be decoded; the build is abandoned unless at least
     * half the bank came back, because a half-measured bank ranks worse than not ranking.
     */
    buildSignatures(getFrame: (i: number) => FramePixels | null, frameCount?: number): boolean;
    private successorDistances;
    /** Squared signature distance `i -> j`, before the median normalisation. */
    private sigDist;
    /**
     * `c(i, j)` from the signatures, in natural playback steps, or `NaN` when there are
     * none. Uses the graph's own two-frame window: a splice is only cheap if what comes NEXT
     * also matches, which is what stops the search entering a run travelling the other way.
     * Deliberately unclipped - see {@link CUT_COST_CLIP}.
     */
    private signatureCost;
    /** Restrict every choice to this pool (`MatcherOptions.frame_pool`). `null` clears it. */
    setAllowed(allowed: Uint8Array | null): void;
    /** Share the matcher's transition cost, which knows where the sequences cut. */
    setCostFn(fn: CutCostFn | null): void;
    /** Whether this instance will ever change a caller's choice. */
    get active(): boolean;
    get frameCount(): number;
    private isAllowed;
    private edgesOf;
    /**
     * Visual cost of `from -> to`: 0 for a step the footage already makes, the graph's own
     * cost for a sanctioned cut, `cJump` for anything else.
     *
     * A host that also has the pose bank injects `setCostFn(matcher.transitionCost)`, which
     * is strictly better informed — it knows that `i -> i+1` across a sequence boundary is
     * a cut, not a step, and this module on its own cannot.
     */
    cost(from: number, to: number): number;
    /**
     * The cheapest way into `[low, high]` from `from`.
     *
     * `starts` are the author's own entry points for that range (`idle_start_positions` /
     * `talk_start_positions`); they do not restrict the search, they break its ties, so a
     * range with two equally cheap entries lands on the one the author actually meant.
     * `fallback` is what the caller would have done unaided, and is returned verbatim when
     * this module is inert — that is the byte-identity guarantee.
     */
    plan(from: number, low: number, high: number, starts: ArrayLike<number> | null, fallback: number, avoid?: ArrayLike<number> | null, biasFn?: CutBiasFn | null): CutPlan;
    /**
     * Shortest visually-cheap walk from `from` into `[lo, hi]`.
     *
     * The difference from {@link bridge} is that the destination is a RANGE, so the search
     * gets to pick the frame it comes out on. That matters: the cheapest entry seen from a
     * standing start is often unreachable, while some other frame of the same range is one
     * cheap hop away.
     *
     * Bounded Dijkstra on the graph's CSR, minimising the WORST edge on the path — that is
     * the step the eye actually catches, not the sum — then the hop count, then the index.
     * Edges at or above `costThreshold` are not walked at all (a bridge made of visible
     * cuts is not a bridge), frames outside the pool are never expanded, so a coverage
     * block is not a shortcut, and the whole search is capped at `maxExpansions` pops: a
     * cut is allowed to be smart, never to drop a frame.
     */
    private bridgeToRange;
    /**
     * A chain of at most `maxBridge` frames from `from` to `to` through the graph's edges,
     * or `null`.
     *
     * Breadth-first by construction, so the shortest bridge wins; inside one depth the
     * frontier is expanded in ascending frame order, so the search is deterministic; and
     * the whole thing is capped at `maxExpansions` edges, so a dense graph costs a bounded
     * amount of work per cut rather than an unbounded one.
     */
    bridge(from: number, to: number): number[] | null;
    /** Zero the counters (a new avatar, a new session). */
    reset(): void;
}
/**
 * Mean visual cost of the frame CHANGES in a run — the acceptance metric for the cut
 * work. Frames that repeat cost nothing (the avatar is holding, not cutting).
 */
declare function cutCostMean(frames: ArrayLike<number>, cost: CutCostFn): number;

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
/** The slice of `AnimationController` this module needs. Duck-typed on purpose. */
interface LegacyHost {
    setTalkingState(talking: boolean): void;
    getAmplitudeFn: (() => number) | null;
    getRmsFn: (() => number) | null;
    getSpectralOpennessFn: (() => number) | null;
    getOpennessFn: (() => number) | null;
    currentFrameIndex: number;
    startPointHintFn: StartPointHintFn | null;
}
/** The one moment an external source may pick a frame: the start of a cycle. */
type StartPointHintFn = (kind: string, positions: number[]) => number | null;
/** The slice of `MotionMatcher` this module needs. */
interface LegacyMatcher {
    blinkEdge(nowMs: number): boolean;
    blinkFrameNear(i: number, maxDelta?: number): number | null;
    startPointScore(candidates: ArrayLike<number> | null | undefined): number | null;
}
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
declare class MicTalkBridge {
    private host;
    threshold: number;
    openTicks: number;
    closeTicks: number;
    private saved;
    private hijacked;
    level: number;
    /** Are WE the reason the avatar is talking? */
    owner: boolean;
    talkTicks: number;
    silenceTicks: number;
    talkTicksTotal: number;
    ticks: number;
    constructor(host: LegacyHost | null, threshold?: number, openTicks?: number, closeTicks?: number);
    /**
     * Redirect the lip-sync getters at our envelope. Idempotent; the originals are restored
     * by `detach` and are delegated to whenever we do not own the mouth, so a TTS bridge
     * that grabs them later still wins.
     */
    attach(): void;
    detach(): void;
    /**
     * One tick. `openness` is 0..1 from the mic (or the camera fallback), `null` when there
     * is no source. Returns whether the user is driving the talk.
     */
    push(openness: number | null | undefined, avatarTalking: boolean): boolean;
    /** Give the mouth back (plugin stop, level change, avatar swap). */
    release(): void;
    private setTalking;
    /** Share of ticks the user owned the talk — the acceptance metric. */
    get talkPct(): number;
}
/**
 * Two ticks on an eye-closed frame of the current sequence, then back home.
 *
 * The detour never changes where the cycler *is*: `home` is the frame the legacy engine
 * had, and it is written straight back when the detour ends, so the sequence resumes from
 * the same place. State only; the caller owns the frame.
 */
declare class BlinkDetour {
    holdTicks: number;
    maxDelta: number;
    remaining: number;
    home: number | null;
    frame: number | null;
    detours: number;
    misses: number;
    constructor(holdTicks?: number, maxDelta?: number);
    reset(): void;
    /**
     * `[frame to force, frame to hand back]` for this tick.
     *
     * - mid-detour -> `[blink frame, null]`
     * - last tick  -> `[null, home]`: the caller restores the cursor and lets legacy run
     * - blink edge -> `[blink frame, null]` if one is close enough, else `[null, null]`
     * - otherwise  -> `[null, null]`
     */
    tick(currentFrame: number, edge: boolean, pick: (i: number) => number | null): [number | null, number | null];
}
interface SutilOptions {
    blinkDetour: boolean;
    blinkHoldTicks: number;
    blinkMaxDelta: number;
    startPointBias: boolean;
    micTalk: boolean;
    micTalkThreshold: number;
    micTalkCloseTicks: number;
}
declare const DEFAULT_SUTIL_OPTIONS: SutilOptions;
/**
 * `presence` end to end: attach to a controller + a matcher, call `onTick` from the
 * controller's mocap branch, and the legacy engine does the rest.
 *
 * `onTick` returns `null` to let the legacy branch run this tick, or the frame index to
 * force for the blink detour. It is the ONLY thing this level ever forces.
 */
declare class SutilDriver {
    private host;
    private matcher;
    readonly mic: MicTalkBridge | null;
    readonly detour: BlinkDetour;
    private savedHint;
    private attached;
    ticks: number;
    forcedTicks: number;
    hints: number;
    readonly opt: SutilOptions;
    constructor(host: LegacyHost | null, matcher: LegacyMatcher | null, options?: Partial<SutilOptions>);
    attach(): void;
    detach(): void;
    /**
     * The one moment the camera may pick a frame: the cycler is starting a cycle and was
     * about to choose at random. Bias it toward the user's smile and yaw.
     */
    startPointHint(_kind: string, positions: number[]): number | null;
    /** One tick. Returns the frame to force, or `null` to let legacy playback run. */
    onTick(nowMs: number, currentFrame: number, micOpenness: number | null, avatarTalking: boolean): number | null;
    stats(): Record<string, unknown>;
}

/** Extra options for {@link AnimationController.configureLipsSync}. */
interface LipSyncExtraOptions {
    /** 1..4.5 loud/quiet sweep-speed ratio. Default 2.237. */
    maxSweepBoost?: number;
    /** Overrides for the voicing-gate DSP. */
    dsp?: LipSyncDspOptions;
}
declare class AnimationController {
    private config;
    private frameCount;
    private currentFrameIndex;
    private idleSpeed;
    private talkSpeed;
    private direction;
    isTalking: boolean;
    private idleBaseMs;
    private talkBaseMs;
    private nativeFps;
    private fpsClamp;
    private pacer;
    private actions;
    private activeAction;
    /** Fired when an action starts. */
    onActionStartCallback: ((id: string) => void) | null;
    /** Fired when an action completes naturally (reached the range end). */
    onActionCompleteCallback: ((id: string) => void) | null;
    /** Fired when an action is force-cancelled. */
    onActionCancelCallback: ((id: string) => void) | null;
    private lipSyncEnabled;
    private opennessMap;
    private dsp;
    private animator;
    private envelope;
    private lipsLastPoll;
    private syntheticValue;
    private syntheticAt;
    /**
     * Instantaneous openness 0..1, supplied by the audio path each frame.
     *
     * Kept as the primary hook for backwards compatibility: when nothing richer
     * is wired, this value drives BOTH the voicing gate and the mouth opening.
     */
    getOpennessFn: (() => number) | null;
    /**
     * RMS of the current audio window, 0..1. Preferred over `getOpennessFn` for
     * the voicing gate — the gate's 0.020 threshold is calibrated in RMS units,
     * and a peak-amplitude reading runs 2-3x the RMS for speech.
     */
    getRmsFn: (() => number) | null;
    /** Peak time-domain amplitude 0..1. Used only if no RMS hook is wired. */
    getAmplitudeFn: (() => number) | null;
    /**
     * A spectral openness estimate 0..1. When present it drives HOW FAR the mouth
     * opens, through its own AGC channel; the gate still keys off the RMS.
     */
    getSpectralOpennessFn: (() => number) | null;
    private matcher;
    private mocapEnabled;
    private mocapActive;
    private mocapMode;
    private mocapDebug;
    private mocapGapMs;
    private mocapGapFired;
    /** Fired when the mocap gap EMA (best RMS error) stays above 0.25 for 2s, and
     * again when it recovers. Best-effort UI hook, not covered by parity fixtures. */
    onMocapGapCallback: ((gapOpen: boolean, emaError: number) => void) | null;
    private mocapPoses;
    private mocapGraph;
    private mocapCoverage;
    private mocapCaps;
    private mocapResolved;
    private mocapComfort;
    /** `"full"` is the default the live sessions settled on; `"head"` is opt-in (§2.5). */
    private mocapWarpRegion;
    private mocapCanBlend;
    private mocapTeleports;
    private mocapLastTransitionCost;
    /** §4.2 crossfade state: the frame being blended out and when the blend started. */
    private mocapFadeFrom;
    private mocapFadeStart;
    private mocapFadeMs;
    /**
     * Who picks the frame at the level in force. `matcher` runs the Ania 2.0 search every
     * tick; `legacy` leaves Ania 1.0 playback — the cycling, the start positions, the
     * ping-pong turns, the authored transitions — in charge and lets the camera in only
     * through {@link SutilDriver}.
     */
    private mocapEngine;
    private sutil;
    /**
     * The flagship of Ania 2.0 and the only part of it that runs with the camera off: at
     * every sequence change the entry frame is chosen through the motion graph instead of
     * by index. Inert without a graph, which is what keeps `verify.mjs` frame-identical.
     */
    private smoothCut;
    private smoothCutOptions;
    private smoothCutRequested;
    /** Bridge frames still to play before the cut's destination is entered. */
    private cutQueue;
    private lastCutCost;
    private lastCutBaseline;
    private lastBridgeFrames;
    /**
     * The one moment an external source may pick a frame without breaking the playback:
     * the start of a cycle, where this controller was about to choose at random.
     * `fn(kind, positions) -> index | null`, `kind` being `'idle' | 'talk' | 'action'`;
     * anything outside `positions` is ignored. `null` — the default — keeps the controller
     * byte-for-byte legacy.
     */
    startPointHintFn: StartPointHintFn | null;
    constructor(config: AnimationControllerConfig, frameCount: number);
    private jumpToRandomStartPosition;
    setTalkingState(talking: boolean): void;
    /**
     * The per-frame interval, in ms, for the current mode.
     *
     * The base is already fps-correct; the speed slider is a multiplier relative
     * to the footage's native rate, and the clamp bounds the result. That is what
     * makes a legacy `talkSpeed={5.3}` a no-op instead of a request for 159 fps.
     */
    getFrameDuration(): number;
    setSpeeds(idleSpeed?: number, talkSpeed?: number): void;
    /** Set the idle animation speed multiplier (relative to the native rate). */
    setIdleSpeed(speed: number): void;
    /** Set the talk animation speed multiplier (relative to the native rate). */
    setTalkSpeed(speed: number): void;
    /** The fps window playback is currently held to, or `null` when unclamped. */
    getFpsClamp(): FpsClampWindow | null;
    /** The footage's resolved frame rate. */
    getNativeFps(): number;
    /** Register the available actions (replaces any prior set). */
    configureActions(actions: ActionConfig[] | undefined): void;
    getActions(): ActionConfig[];
    hasAction(id: string): boolean;
    /** Begin playing an action by id. Returns true if the action exists. */
    triggerAction(actionId: string): boolean;
    /**
     * Cancel the active action. With `force`, fires the cancel callback;
     * otherwise it's treated as a natural completion.
     */
    cancelAction(force?: boolean): void;
    isActionPlaying(): boolean;
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
    configureLipsSync(enabled: boolean, intensity?: number, responsiveness?: number, opennessMap?: number[] | null, sustainStyle?: LipSyncSustainStyle, wiggleSpeed?: number, options?: LipSyncExtraOptions): void;
    isLipSyncEnabled(): boolean;
    getLipSyncEnvelope(): number;
    /** Which frame branch ran last: sustain | silence | voiced. For debug probes. */
    getLipSyncBranch(): LipAnimatorBranch | null;
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
    pushSyntheticOpenness(value?: number): void;
    /**
     * Force the mouth shut immediately.
     *
     * Called when playback is cancelled or the chunk queue is drained. Without it
     * the avatar holds whatever talk frame it was on until the next audio block —
     * which, having been cancelled, never arrives. The desktop hit exactly this
     * and fixed it the same way. It is the one sanctioned jump cut.
     */
    forceLipsClosed(): void;
    /**
     * Load a pose bank (+ optional motion graph, coverage and reaction level) built for
     * this avatar. `null` tears the mocap path down. Returns `false` (and logs) on a
     * `descriptorVersion` mismatch — the caller keeps playing normally.
     *
     * Everything past `poses` is optional and additive: the pre-levels call shape
     * `configureMocap({ poses, motionGraph, options })` still behaves exactly as it did,
     * because a config with no `level` resolves to `off` and leaves `options` in charge.
     */
    configureMocap(index: MocapConfigureInput | null): boolean;
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
    } | null): boolean;
    /** Build or drop the cut planner to match the graph and the requested mode. */
    private syncSmoothCut;
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
    private planCut;
    /**
     * The frame a cycle starts on: the hint when there is one and it is a real option, the
     * historic random choice otherwise. Mirrors the Python reference's
     * `_pick_start_position`.
     */
    private pickStartPosition;
    /**
     * Run SmoothCut for a cycle start and return the frame to SHOW now, or `null` when the
     * planner had no opinion (no graph, nothing rankable) and the caller should keep its
     * own choice. `this.currentFrameIndex` is left on the entry either way, so cycling
     * continues from there once any bridge has drained.
     */
    private planCutInto;
    /** Rebuild the matcher from the stored bank + the current comfort object. */
    private rebuildMatcher;
    /**
     * Switch the reaction level in place (`off | presence | expressive | mirror`).
     * Rebuilds the matcher from the bank already loaded; returns the level actually
     * granted, which is lower than the one asked for when the bank cannot show it.
     */
    setMocapLevel(level: string): string;
    /** Update one or more comfort keys (§3) without changing the level. */
    setMocapComfort(comfort: Partial<MocapComfortInput>): ResolvedOptions | null;
    /**
     * Where the user's mouth-OPEN value comes from: `audio | camera | mic | hybrid`.
     * `presence` always keeps `audio` whatever is asked for. Returns the source granted.
     */
    setMouthSource(source: string): string;
    /**
     * Push the USER's microphone envelope (0..1) for the `mic`/`hybrid` mouth sources.
     * `null` says there is no mic, which drops the matcher back to the camera's MAR. The
     * envelope itself is measured capture-side; the matcher only consumes it.
     */
    pushMicOpenness(value: number | null, atMs?: number): void;
    /** Tear the §Sutil driver down and unhook everything it installed. */
    private teardownSutil;
    /**
     * Stand the §Sutil driver up for a legacy-engine level, or tear it down for anything
     * else. Called on every matcher rebuild, so a level change swaps engines cleanly.
     */
    private syncSutil;
    /** Whether the level in force wants a microphone envelope pushed into it. */
    mocapNeedsMic(): boolean;
    /**
     * Hand the legacy lip-sync openness map to the ARTICULATE search, so the camera path
     * picks the same mouths the audio path would.
     */
    private wireOpennessMap;
    /**
     * What this bank can physically show, plus the pt-BR warnings for the level in
     * force. `caps` are the §5.1 0/1 flags + a `metrics` block; `warnings` carry both
     * the i18n key and the ready-made sentence.
     */
    getMocapCapabilities(): MocapCapabilitiesReport;
    /** The resolved option table for the level in force (matcher knobs, affine caps). */
    getMocapOptions(): ResolvedOptions | null;
    /** Feed one live pose sample (from a webcam/mocap capture source). */
    pushPose(desc: PoseDescriptorMessage): void;
    setMocapEnabled(enabled: boolean): void;
    /** Whether the mocap branch drove the last rendered frame. */
    isMocapActive(): boolean;
    getMocapMode(): string | null;
    /**
     * HUD/debug snapshot. Carries the numeric matcher counters plus the four fields the
     * levels UI shows: the granted `level`, whether the mouth is on `audio` or `camera`
     * right now, the visual cost of the last transition, and the teleport count.
     */
    getMocapDebug(): MocapDebugReport | null;
    /** Live target minus the currently rendered frame's descriptor (affine warp input). */
    getMocapResidual(): number[] | null;
    /**
     * Everything the renderer needs for one tick: the affine params for the residual
     * warp, the head ellipse to composite them through (or `null` for a whole-frame
     * warp), and the crossfade state when the matcher just took a visible jump.
     *
     * Returns `null` while the mocap branch is not driving the avatar, in which case
     * the renderer draws the frame exactly as it always did — which is what keeps
     * `verify.mjs` frame-identical with mocap off.
     */
    getMocapWarp(width: number, height: number, nowMs: number): MocapWarpState | null;
    /** The talk range, floored and bounded by the real frame count. */
    private talkRange;
    /**
     * The raw signals for this tick, as `{rms, openness}`.
     *
     * Returns null ONLY when no audio source is wired at all. A source that is
     * present but silent must report 0, never null: the silence branch depends on
     * being FED zeros. Returning null there was the old behaviour, and it fell
     * through to the blind frame cycler — which is precisely why the mouth kept
     * flapping after the audio had already stopped.
     */
    private lipsSignals;
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
    getNextFrame(timestamp: number): number;
}

/** Cloud/keyless TTS providers handled by the built-in tts-api service. */
type TTSProvider = 'browser' | 'tiktok' | 'google' | 'azure' | 'elevenlabs' | 'piper';
/** STT providers handled by the built-in speech-recognition helper. */
type STTProvider = 'browser' | 'google';
/** Lip-sync sustain shaping while a vowel is held. */
type LipSyncSustainStyle = 'hold' | 'wiggle';
/**
 * Decrypted `.ania` avatar payload. `video.frames` are base64 WebP strings.
 * `animation` carries the idle/talk ranges + speeds the renderer drives.
 */
interface AniaAvatarData {
    version: string;
    /** Content hash used for server-side actions / lip-sync config lookups. */
    contentHash?: string;
    video: {
        frames: string[];
        fps?: number;
        width?: number;
        height?: number;
    };
    animation: AniaAnimationData;
    config?: {
        idleFrameDuration?: number;
        talkCycleDuration?: number;
        transitionDuration?: number;
    };
    /** Optional embedded actions (from the .ania file). */
    actions?: ActionConfig[];
    /** Allow unknown fields without losing type-safety on the known ones. */
    [key: string]: unknown;
}
/** Raw animation block as stored in the .ania file (camelCase keys). */
interface AniaAnimationData {
    idleRangeLowValue?: number;
    idleRangeHighValue?: number;
    talkRangeLowValue?: number;
    talkRangeHighValue?: number;
    currentFrameIndex?: number;
    reverseIdleSelected?: boolean;
    reverseTalkSelected?: boolean;
    transitionSpeedSliderValue?: number;
    idleSpeedSliderValue?: number;
    talkSpeedSliderValue?: number;
    idleStartPositions?: number[];
    talkStartPositions?: number[];
    [key: string]: unknown;
}
/** Normalized config consumed by {@link AnimationController}. */
interface AnimationControllerConfig {
    idle_range_low?: number;
    idle_range_high?: number;
    talk_range_low?: number;
    talk_range_high?: number;
    idle_speed_slider_value?: number;
    talk_speed_slider_value?: number;
    current_frame_index?: number;
    idle_start_positions?: number[];
    talk_start_positions?: number[];
    reverse_idle_selected?: boolean;
    reverse_talk_selected?: boolean;
    /** Milliseconds per idle frame. Defaults to `1000 / ania_native_fps`. */
    idle_frame_duration?: number;
    /** Milliseconds per talk frame. Defaults to `1000 / ania_native_fps`. */
    talk_cycle_duration?: number;
    /**
     * The footage's own frame rate, from the `.ania`'s `video.fps`. Absent falls
     * back to `FPS_FALLBACK` (25), which sits inside the default window.
     */
    ania_native_fps?: number;
    /**
     * The window playback is held to: omitted/`true` for the default 24-30,
     * `false` to opt out of clamping, or a custom `{ min, max }`.
     */
    ania_fps_clamp?: FpsClampOption;
}
/**
 * A named clip that plays a sub-range of the avatar's frames at a given
 * speed/direction, optionally from a random start position, and optionally
 * plays a base64 audio clip. Mirrors the desktop player's action system.
 */
interface ActionConfig {
    id: string;
    name: string;
    hotkey?: string;
    range_low: number;
    range_high: number;
    start_positions?: number[];
    speed?: number;
    reverse?: boolean;
    audio_base64?: string;
    audio_delay_ms?: number;
}
/** Lightweight id+name pair (e.g. for menus / command listing). */
interface ActionInfo {
    id: string;
    name: string;
}
/** Advanced lip-sync knobs ported from the desktop player. */
interface LipSyncConfig {
    enabled: boolean;
    /** 0..1 openness boost. */
    intensity: number;
    /** 0.05..1 envelope smoothing factor (higher = snappier). */
    responsiveness: number;
    sustainStyle: LipSyncSustainStyle;
    /** 1..6 wiggle oscillation speed for held vowels. */
    wiggleSpeed: number;
    /** Optional per-talk-frame openness map (built via buildOpennessMap). */
    opennessMap?: number[] | null;
}
/** Server-side lip-sync config returned by the avatar-config API. */
interface LipSyncServerConfig {
    lips_sync_keyframes?: [number, number][];
    lips_sync_sync_intensity?: number;
    lips_sync_responsiveness?: number;
    lips_sync_sustain_style?: LipSyncSustainStyle;
    lips_sync_wiggle_speed?: number;
}
interface TTSConfig {
    provider: TTSProvider;
    apiKey?: string;
    apiUrl?: string;
    voiceId?: string;
    model?: string;
    lang?: string;
    gender?: 'male' | 'female' | 'auto';
    rate?: number;
    pitch?: number;
    /** Azure region (e.g. 'brazilsouth'). */
    region?: string;
    /** Piper on-device ONNX options. */
    piperModelUrl?: string;
    piperModelConfigUrl?: string;
    piperSpeakerId?: number;
}
interface TTSResult {
    audioUrl: string;
    duration: number;
}
/** Visual anchor for the player target (only used by wrappers if they want). */
type PlayerPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
/** Options passed to {@link createAniaPlayer}. */
interface PlayerOptions {
    /** Canvas pixel width. Defaults to the canvas element's width or 200. */
    width?: number;
    /** Canvas pixel height. Defaults to the canvas element's height or 200. */
    height?: number;
    /** Start the render loop immediately after a successful load. Default true. */
    autoplay?: boolean;
    /** Override idle animation speed (otherwise read from the avatar file). */
    idleSpeed?: number;
    /** Override talk animation speed (otherwise read from the avatar file). */
    talkSpeed?: number;
    /** Auto-derive idle/talk speeds from the avatar fps. Default false. */
    autoCalculateSpeed?: boolean;
    /** Initial lip-sync config. Default: disabled. */
    lipSync?: Partial<LipSyncConfig>;
    /** Base server URL for fetching actions / lip-sync config by contentHash. */
    serverUrl?: string;
    /** Fetch additional actions config from the server on load. Default false. */
    fetchActionsFromServer?: boolean;
    /** Locale for any built-in strings the wrapper resolves through this engine. */
    locale?: string;
    /** Optional logger; defaults to the global console. */
    logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}
/** Source descriptor for {@link AniaPlayerInstance.load}. */
interface LoadSource {
    /** URL to a `.ania` file (downloaded via fetch). */
    url?: string;
    /** Password for an encrypted (personal) `.ania` file. */
    password?: string;
    /** Bearer token sent as `Authorization` when downloading a URL. */
    authToken?: string;
    /** Already-decrypted avatar data (skips download + decrypt). */
    data?: AniaAvatarData;
}
/** Events emitted by an {@link AniaPlayerInstance}. */
interface PlayerEventMap {
    load: AniaAvatarData;
    talkStart: void;
    talkEnd: void;
    actionStart: string;
    actionEnd: string;
    error: Error;
    /** Mocap coverage gap: EMA of the best RMS error stayed above 0.25 for 2s
     * (`true`), or recovered (`false`). Best-effort UI hook. */
    mocapGap: {
        gapOpen: boolean;
        emaError: number;
    };
}
type PlayerEventName = keyof PlayerEventMap;
/** Imperative handle returned by {@link createAniaPlayer}. */
interface AniaPlayerInstance {
    /** Load avatar data (from raw `AniaAvatarData`, or a `{url,password,authToken}` source). */
    load(source: AniaAvatarData | LoadSource): Promise<AniaAvatarData>;
    /** Start the render loop. */
    play(): void;
    /** Stop the render loop (frame freezes). */
    pause(): void;
    /** Stop, detach listeners, and remove the canvas the engine created. */
    destroy(): void;
    /** Force the talking/idle state (e.g. while TTS audio plays). */
    setTalking(talking: boolean): void;
    /** Trigger an action by id. Returns true if the action exists. */
    triggerAction(id: string): boolean;
    /** Cancel the active action. `force` fires the cancel (vs natural-complete) callback. */
    cancelAction(force?: boolean): void;
    /** Replace the registered action set. */
    configureActions(actions: ActionConfig[]): void;
    /** Configure advanced lip-sync. */
    configureLipsSync(enabled: boolean, intensity?: number, responsiveness?: number, opennessMap?: number[] | null, sustainStyle?: LipSyncSustainStyle, wiggleSpeed?: number): void;
    /** All currently-registered actions as id+name pairs. */
    getAvailableActions(): ActionInfo[];
    /**
     * Set the openness source feeding lip-sync each frame (0..1). Pass a
     * {@link LipSyncAnalyser} (via `.getOpenness`) or any `() => number`.
     */
    setOpennessSource(fn: (() => number) | null): void;
    /** Set idle/talk speeds at runtime. */
    setSpeeds(idleSpeed?: number, talkSpeed?: number): void;
    /** Load a pose bank (+ optional motion graph) for Ania 2.0 motion matching.
     * `null` tears it down. Returns `false` on a `descriptorVersion` mismatch. */
    configureMocap(index: MocapConfigureInput | null): boolean;
    /** Feed one live pose sample from a webcam/mocap capture source. */
    pushPose(desc: PoseDescriptorMessage): void;
    /** Enable/disable the mocap-driven frame source. */
    setMocapEnabled(enabled: boolean): void;
    /** Switch the reaction level; returns the level actually granted. */
    setMocapLevel(level: string): string;
    /** Update one or more of the six comfort keys without changing the level. */
    setMocapComfort(comfort: MocapComfortInput): unknown;
    /** Set the mouth source (`audio | camera | mic | hybrid`); returns the one granted. */
    setMouthSource(source: string): string;
    /** Push the USER's microphone envelope (0..1, or `null` for "no mic"). */
    pushMicOpenness(value: number | null, atMs?: number): void;
    /**
     * Ania 2.0 cut smoothing, with or without a camera: hand it the avatar's motion graph
     * and every sequence change picks its entry frame through the graph. Returns whether
     * smoothing is actually active.
     */
    configureSmoothCut(config: SmoothCutConfigureInput | null): boolean;
    /** What this bank can show + the pt-BR warnings for the level in force. */
    getMocapCapabilities(): MocapCapabilitiesReport;
    /** Whether the mocap branch drove the last rendered frame. */
    isMocapActive(): boolean;
    /** `'LIVE' | 'DECAY' | 'IDLE' | null` (null before the first mocap tick). */
    getMocapMode(): string | null;
    /** Debug counters from the last mocap step + level/mouthSource/lastTransitionCost/teleports. */
    getMocapDebug(): MocapDebugReport | null;
    /** Live target minus the currently rendered frame's descriptor. */
    getMocapResidual(): number[] | null;
    /** The live underlying controller (advanced use). */
    readonly controller: AnimationController | null;
    /** The `<canvas>` the engine renders to. */
    readonly canvas: HTMLCanvasElement;
    /** Subscribe to a player event. Returns an unsubscribe fn. */
    on<E extends PlayerEventName>(event: E, cb: (payload: PlayerEventMap[E]) => void): () => void;
    /** Unsubscribe a previously-registered listener. */
    off<E extends PlayerEventName>(event: E, cb: (payload: PlayerEventMap[E]) => void): void;
}
type PluginKind = 'tts' | 'stt' | 'wakeword' | 'action' | 'integration';
declare const PLUGIN_KINDS: readonly PluginKind[];
interface PluginContext {
    /** Per-subsystem config (e.g. the TTS config bag). */
    config?: Record<string, unknown>;
    /** The owning registry. */
    registry?: PluginRegistryLike;
    /** Optional logger; defaults to console. */
    logger?: Pick<Console, 'log' | 'warn' | 'error'>;
    [key: string]: unknown;
}
/** TTS engine produced by a `tts` plugin's `createEngine`. */
interface TTSEngine {
    speak(text: string, options?: Record<string, unknown>): Promise<unknown> | unknown;
    synthesize?(text: string, options?: Record<string, unknown>): Promise<{
        audioUrl: string;
        blob?: Blob;
    }>;
    stop?(): void;
    cleanup?(): void;
}
/** STT engine / descriptor produced by an `stt` plugin's `createEngine`. */
interface STTEngine {
    provider?: STTProvider | string;
    startListening?(options?: Record<string, unknown>): Promise<boolean>;
    stopListening?(): void;
    cleanup?(): void;
}
/** Wake-word engine shape produced by a `wakeword` plugin's `createEngine`. */
interface WakeWordEngineLike {
    loadModel?(modelUrl?: string, options?: {
        wasmPaths?: string;
    }): Promise<unknown>;
    startListening(config: WakeWordStartConfig): Promise<boolean>;
    stopListening(): void | Promise<void>;
    isModelLoaded?(): boolean;
    isCurrentlyListening?(): boolean;
    dispose?(): void | Promise<void>;
}
interface WakeWordStartConfig {
    threshold: number;
    onDetect: (score?: number) => void;
    onError?: (e: Error) => void;
    onScore?: (n: number) => void;
}
/** A single settings field a host can render for a plugin. */
interface PluginSettingField {
    key: string;
    label: string;
    type: 'string' | 'password' | 'number' | 'boolean' | 'select';
    options?: {
        value: string;
        label: string;
    }[];
    placeholder?: string;
    description?: string;
    default?: string | number | boolean;
}
/** A registrable plugin. Plain object — no class to extend. */
interface Plugin {
    id: string;
    name: string;
    version?: string;
    description?: string;
    kind: PluginKind;
    enabled?: boolean;
    builtin?: boolean;
    settingsSchema?: PluginSettingField[];
    init?(ctx: PluginContext): void | Promise<void>;
    start?(): void | Promise<void>;
    stop?(): void | Promise<void>;
    createEngine?(ctx: PluginContext): TTSEngine | STTEngine | WakeWordEngineLike | unknown;
    createHandler?(ctx: PluginContext): unknown;
}
/** Structural type for the registry (avoids a circular import in types). */
interface PluginRegistryLike {
    register(plugin: Plugin): () => void;
    get(id: string): Plugin | null;
    list(): Plugin[];
    getByKind(kind: PluginKind): Plugin[];
    setActive(kind: PluginKind, id: string): void;
    getActive(kind: PluginKind): Plugin | null;
}
interface CommandContext {
    player?: AniaPlayerInstance | {
        play?: () => void;
        pause?: () => void;
        controller?: unknown;
    };
    getActions?: () => ActionInfo[];
    triggerAction?: (id: string) => void;
    cancelAction?: () => void;
    speak?: (text: string, options?: Record<string, unknown>) => void;
    ask?: (text: string) => void | Promise<unknown>;
    setVisible?: (visible: boolean) => void;
    getVisible?: () => boolean;
    setMuted?: (muted: boolean) => void;
    setSensitivity?: (value: number) => void;
    setSpeeds?: (idle: number, talk: number) => void;
    triggerWake?: () => void;
    stopSpeaking?: () => void;
    onInfo?: (info: unknown) => void;
    logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}
interface CommandResult {
    ok: boolean;
    message: string;
    data?: unknown;
}
interface CommandDescriptor {
    cmd: string;
    desc: string;
}
/** Variables for `{{var}}` interpolation. */
type I18nVars = Record<string, string | number>;
/** Consumer override table: scalar keys -> string, list keys -> string[]. */
type MessagesOverride = Record<string, string | string[]>;
interface Translator {
    locale: string;
    t: (key: string, vars?: I18nVars) => string;
    list: (key: string) => string[];
}
/**
 * The six comfort keys of §3, all optional. `level` is the single user-facing dial;
 * everything else has a per-level default and is clamped, never rejected.
 */
interface MocapComfortInput {
    /** `off | presence | expressive | mirror`. */
    level?: string;
    /** 0.5 .. 1.5 — scales the retarget gain and the affine strength. */
    intensity?: number;
    /** 0.5 .. 2.0 — scales the One-Euro min-cutoff (EYES is pinned at 3 Hz). */
    smoothing?: number;
    /** `auto | on | off` — blend a visible jump over <= 120 ms. */
    crossfade?: 'auto' | 'on' | 'off';
    /** Idle micro-motion when the user is still (§4.4). */
    breathing?: boolean;
    /** Mirror the driver left/right (a selfie view of the user). */
    mirror?: boolean;
    /**
     * Where the user's mouth-OPEN value comes from once the level hands the mouth over:
     * `audio` (never handed over), `camera` (the webcam MAR), `mic` (the microphone
     * envelope) or `hybrid` (`max(mic, camera x 0.6)`). `off` is always `audio`; at
     * `presence` the blend is fed to the player's own lip-sync path, not to the matcher.
     */
    mouth_source?: 'audio' | 'camera' | 'mic' | 'hybrid';
    /**
     * Which frames of the bank the level may show. `legacy` keeps the avatar inside the
     * sequences its creator authored (idle / talk / action) and locks out everything an
     * Ania 2.0 coverage upgrade appended; `all` is opt-in and `mirror` only.
     */
    frame_pool?: 'legacy' | 'all';
}
/** Argument of `AnimationController.configureMocap`. */
interface MocapConfigureInput extends MocapComfortInput {
    poses: MocapIndex['poses'];
    motionGraph?: MocapIndex['motionGraph'];
    /** Parsed `coverage.json`. Needed by the §5.1 capability probe. */
    coverage?: unknown;
    /** Where a residual warp may act. Default `"full"`; `"head"` is opt-in. */
    warpRegion?: 'head' | 'full';
    /** Whether the renderer can composite two frames. Default `true`. */
    canBlend?: boolean;
    /** Raw matcher overrides, applied on top of the level's table. */
    options?: MocapIndex['options'];
    /** Camel-case alias of `frame_pool`, for hosts that pass a JS-shaped config. */
    framePool?: 'legacy' | 'all';
    /**
     * Ania 2.0 cut smoothing. `true`/`'auto'` picks every sequence entry through the
     * motion graph (and needs one); `false` keeps the historic index-based cuts.
     * Independent of the camera: it works with `setMocapEnabled(false)`.
     */
    smoothCut?: boolean | 'auto';
}
/** Argument of `AnimationController.configureSmoothCut`. */
interface SmoothCutConfigureInput {
    /** The avatar's `motion_graph.json`. Without one every cut stays exactly as it was. */
    motionGraph?: MocapIndex['motionGraph'];
    enabled?: boolean | 'auto';
    /** Longest bridge to play on the way into a cut, in frames. Default 3. */
    maxBridge?: number;
    /** Longest dissolve when no bridge is found. Default 120 ms. */
    crossfadeMs?: number;
}
/** One pt-BR warning: the i18n key plus the ready-made sentence. */
interface MocapWarningReport {
    key: string;
    text: string;
}
/** Result of `AnimationController.getMocapCapabilities()`. */
interface MocapCapabilitiesReport {
    caps: Record<string, unknown>;
    level: string;
    requestedLevel: string;
    blocked: boolean;
    active: boolean;
    canBlend: boolean;
    crossfade: 'auto' | 'on' | 'off';
    channels: string[];
    missingChannels: string[];
    warnings: MocapWarningReport[];
    comfort: Record<string, unknown> | null;
}
/** Result of `AnimationController.getMocapDebug()`. */
interface MocapDebugReport extends Record<string, unknown> {
    level: string;
    /** What is driving the mouth right now. */
    mouthSource: 'audio' | 'camera';
    lastTransitionCost: number;
    teleports: number;
    breathing: boolean;
    /** Blink priority events taken since the matcher was built. */
    blinks: number;
    /** The ARTICULATE sub-state is driving the mouth this tick. */
    articulating: boolean;
    /** The configured mouth source (`audio | camera | mic | hybrid`). */
    mouthSourceMode: string;
    warpRegion: 'head' | 'full';
    /** Who picked the frame: `legacy` (Ania 1.0 playback + hooks) or `matcher`. */
    engine: string;
    /** Which frames the level may show (`legacy` excludes the coverage blocks). */
    framePool: string;
    /** Graph cost of the last sequence cut SmoothCut planned. */
    lastCutCost: number;
    /** What that cut would have cost with the legacy random start point. */
    lastCutBaseline: number;
    /** How many bridge frames the last cut played on the way in. */
    bridgeFrames: number;
}
/** The §4.2 alpha blend of the outgoing frame over the incoming one. */
interface MocapCrossfadeState {
    fromFrame: number;
    /** Weight of the NEW frame, 0..1. */
    alpha: number;
}
/** Everything the renderer needs for one mocap tick. */
interface MocapWarpState {
    params: {
        tx: number;
        ty: number;
        rot_deg: number;
        scale: number;
        pivot: [number, number];
    };
    /** The feathered head ellipse, or `null` for a whole-frame warp. */
    region: {
        cx: number;
        cy: number;
        rx: number;
        ry: number;
        feather: number;
    } | null;
    crossfade: MocapCrossfadeState | null;
    warpRegion: 'head' | 'full';
}

/**
 * Create an avatar player on `target`.
 *
 * @param target A `<canvas>` to render into, or any element to create a canvas inside.
 * @param options See {@link PlayerOptions}.
 */
declare function createAniaPlayer(target: HTMLCanvasElement | HTMLElement, options?: PlayerOptions): AniaPlayerInstance;

interface AniaPlayerRenderOptions {
    width: number;
    height: number;
    /** Override the data-URL mime for frames. Default 'image/webp'. */
    frameMime?: string;
}
declare class AniaPlayer {
    readonly canvas: HTMLCanvasElement;
    private ctx;
    private frameImages;
    private isPlaying;
    private animationFrame;
    private lastRenderedFrame;
    private frameMime;
    private warpCanvas;
    private warpCtx;
    private maskCanvas;
    private maskCtx;
    private maskKey;
    fileData: AniaAvatarData | null;
    animationController: AnimationController | null;
    /**
     * @param canvas A target <canvas> to render into.
     * @param options Pixel size + optional frame mime.
     */
    constructor(canvas: HTMLCanvasElement, options: AniaPlayerRenderOptions);
    /** Decode + cache a single frame Image by index. */
    loadFrame(index: number): Promise<HTMLImageElement | null>;
    /** Draw a frame by index (skips redundant redraws of the same frame). */
    renderFrame(index: number): Promise<void>;
    /**
     * Draw one mocap tick: the body frame as decoded, then — when the level asked for a
     * head-only warp — the head region re-drawn through the affine transform behind a
     * feathered elliptical mask, and finally the §4.2 alpha blend of the frame we are
     * jumping away from.
     *
     * `warp === null` (mocap off, or the matcher not driving) short-circuits straight
     * back to {@link renderFrame}, which is what keeps the no-mocap output byte-identical.
     */
    renderMocapFrame(index: number, warp: MocapWarpState | null): Promise<void>;
    /** `out = R·S·(in - pivot) + pivot + t`, as a canvas transform. */
    private applyTransform;
    private ensureWarpLayer;
    /**
     * The feathered head ellipse as an alpha bitmap. Same ramp as the Python
     * `affine.region_alpha`: 1 inside, 0 outside, a linear fall-off of `feather`
     * (measured along the y axis) across the boundary — expressed as a radial gradient
     * on a unit circle that an ellipse transform stretches, so there is no per-pixel JS.
     * Cached per (region, size); the region only changes when the matcher picks another
     * frame, so the per-tick cost is one lookup.
     */
    private ensureMask;
    /** Start the rAF render loop. */
    play(): void;
    /** Stop the render loop (the last frame stays painted). */
    stop(): void;
    isRunning(): boolean;
    setTalkingState(talking: boolean): void;
    /** Release cached frame images. */
    dispose(): void;
}
/**
 * Build a normalized {@link AnimationControllerConfig} from the avatar file's
 * raw camelCase `animation` block.
 */
declare function buildControllerConfig(data: AniaAvatarData): AnimationControllerConfig;

declare class Emitter<EventMap> {
    private listeners;
    on<E extends keyof EventMap>(event: E, cb: (payload: EventMap[E]) => void): () => void;
    off<E extends keyof EventMap>(event: E, cb: (payload: EventMap[E]) => void): void;
    emit<E extends keyof EventMap>(event: E, payload: EventMap[E]): void;
    clear(): void;
}

/**
 * Decrypt a `.ania` file buffer into its avatar data. For market/unencrypted
 * avatars the `password` is ignored.
 *
 * @param encryptedData The raw `.ania` file bytes.
 * @param password      Password for personal (encrypted) avatars. Optional for market avatars.
 */
declare function decryptAniaFile(encryptedData: ArrayBuffer, password?: string): Promise<AniaAvatarData>;

interface LipSyncAnalyserOptions {
    /** FFT size (power of two). Default 2048. */
    fftSize?: number;
    /** Analyser smoothing 0..1. Default 0.8. */
    smoothing?: number;
    /** Linear gain applied to the openness reading. Default 1. */
    inputGain?: number;
}
declare class LipSyncAnalyser {
    private ctx;
    private analyser;
    private source;
    private freqData;
    private prevSpectrum;
    private ownsStream;
    private stream;
    private connectedElement;
    private fftSize;
    private smoothing;
    inputGain: number;
    constructor(options?: LipSyncAnalyserOptions);
    private getOrCreateContext;
    private buildAnalyser;
    /**
     * Connect a microphone. Requests `getUserMedia({ audio })` unless a stream is
     * supplied. The mic is NOT routed to the speakers (analysis only).
     */
    connectMicrophone(stream?: MediaStream, deviceId?: string): Promise<void>;
    /** Connect a raw MediaStream (e.g. system / tab audio). */
    connectStream(stream: MediaStream): Promise<void>;
    /**
     * Connect an `<audio>`/`<video>` element (e.g. a TTS playback element). The
     * element's audio is routed through to the speakers so it still plays.
     */
    connectAudioElement(el: HTMLMediaElement): void;
    /**
     * Average magnitude over the speech band (85–3000 Hz), normalized 0..1 and
     * scaled by `inputGain`. This is the value to feed the controller.
     */
    getOpenness(): number;
    /** Peak time-domain amplitude 0..1. */
    getAmplitude(): number;
    /** Positive spectral flux 0..1 (rising energy). */
    getSpectralFlux(): number;
    isConnected(): boolean;
    /** Detach nodes and stop any stream this analyser created. */
    disconnect(): void;
    /** Fully dispose (disconnect + close the AudioContext). */
    destroy(): Promise<void>;
}

interface SpeechRecognitionOptions {
    sttProvider?: STTProvider;
    sttLang?: string;
    sttContinuous?: boolean;
    sttInterimResults?: boolean;
    sttApiKey?: string | null;
    sttApiUrl?: string | null;
    onTranscriptChange?: (text: string, isFinal: boolean) => void;
    onFinalTranscript?: (text: string) => void;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (error: Error) => void;
}
/**
 * A reusable STT controller. Call {@link startListening} to begin and
 * {@link stopListening} to end; transcript text arrives via the callbacks
 * passed in the options (or in the constructor).
 */
declare class SpeechRecognizer {
    private opts;
    private recognition;
    private mediaRecorder;
    private audioChunks;
    private listening;
    constructor(opts?: SpeechRecognitionOptions);
    isListening(): boolean;
    /** Whether the browser Web Speech API is available. */
    static isBrowserSupported(): boolean;
    /** Start listening. Returns true if recognition started. */
    startListening(override?: SpeechRecognitionOptions): Promise<boolean>;
    private startBrowser;
    private startGoogle;
    /** Stop listening and release resources. */
    stopListening(): void;
}

declare const COMMAND_LIST: CommandDescriptor[];
/** Split a command line into `{ verb, args, rest }`, honoring quotes. */
declare const parseCommandLine: (line: string) => {
    verb: string;
    args: string[];
    rest: string;
};
/**
 * Execute one command line against `ctx`. Synchronous (handlers may be async
 * but their result is not awaited here). Returns `{ ok, message, data? }`.
 */
declare const executeCommand: (line: string, ctx?: CommandContext) => CommandResult;
/**
 * Install an origin-allowlisted `window.postMessage` listener that runs incoming
 * commands. Host pages drive the avatar via:
 *   `window.postMessage({ source: 'ania', cmd: 'action 1' }, targetOrigin)`
 *
 * @returns an uninstall function.
 */
declare const installPostMessageControl: (ctx: CommandContext, options?: {
    origins?: string[];
    onResult?: (result: CommandResult, event: MessageEvent) => void;
}) => (() => void);

/** Throws if `plugin` doesn't satisfy the minimum contract; returns it otherwise. */
declare const validatePlugin: (plugin: Plugin) => Plugin;
type RegistryListener = (registry: PluginRegistry) => void;
declare class PluginRegistry {
    private plugins;
    private active;
    private initialized;
    private listeners;
    logger: Pick<Console, 'log' | 'warn' | 'error'>;
    /** Subscribe to registry changes. Returns an unsubscribe fn. */
    subscribe(listener: RegistryListener): () => void;
    private emit;
    /**
     * Register a plugin. The first registered provider of a tts/stt/wakeword kind
     * becomes the active provider for that kind unless one is already active.
     * @returns an unregister fn for this plugin.
     */
    register(plugin: Plugin): () => void;
    /** Register many plugins at once. */
    registerAll(plugins?: Plugin[]): void;
    /** Remove a plugin by id. Clears/re-selects the active slot if it pointed here. */
    unregister(id: string): void;
    get(id: string): Plugin | null;
    /** All registered plugins (insertion order). */
    list(): Plugin[];
    /** All plugins of a given kind. */
    getByKind(kind: PluginKind): Plugin[];
    /** Enable/disable a plugin. Disabling the active provider re-selects. */
    setEnabled(id: string, enabled: boolean): void;
    /** Mark which provider is active for a subsystem. */
    setActive(kind: PluginKind, id: string): void;
    /** Id of the active provider for a kind (or null). */
    getActiveId(kind: PluginKind): string | null;
    /** The active provider plugin for a kind (or null). */
    getActive(kind: PluginKind): Plugin | null;
    /** Ensure a plugin's init() has run exactly once, then return the plugin. */
    ensureInit(id: string, ctx?: PluginContext): Promise<Plugin | null>;
    /** Resolve the active engine for a tts/stt/wakeword subsystem. */
    resolveEngine(kind: 'tts' | 'stt' | 'wakeword', ctx?: PluginContext): Promise<TTSEngine | STTEngine | WakeWordEngineLike | null>;
    /** Resolve handlers for all enabled action/integration plugins of a kind. */
    resolveHandlers(kind: 'action' | 'integration', ctx?: PluginContext): Promise<Array<{
        id: string;
        handler: unknown;
    }>>;
    /** Start every enabled plugin that exposes start(). */
    startAll(ctx?: PluginContext): Promise<void>;
    /** Stop every plugin that exposes stop(). */
    stopAll(): Promise<void>;
}
declare const getDefaultRegistry: () => PluginRegistry;

declare const ttsBrowserPlugin: Plugin;
declare const ttsTiktokPlugin: Plugin;
declare const ttsElevenLabsPlugin: Plugin;
declare const ttsGooglePlugin: Plugin;
declare const ttsAzurePlugin: Plugin;
/** Piper on-device ONNX provider (optional deps loaded lazily). */
declare const ttsPiperPlugin: Plugin;
declare const sttBrowserPlugin: Plugin;
declare const sttGooglePlugin: Plugin;
declare const wakeWordPlugin: Plugin;
declare const actionAudioPlugin: Plugin;
/** Every built-in, in registration order. */
declare const BUILTIN_PLUGINS: Plugin[];
/** Map a legacy `ttsProvider` string to its built-in plugin id. */
declare const TTS_PROVIDER_TO_PLUGIN: Record<string, string>;
/** Map a legacy `sttProvider` string to its built-in plugin id. */
declare const STT_PROVIDER_TO_PLUGIN: Record<string, string>;
/** Register all built-ins onto a registry (idempotent — skips existing ids). */
declare const registerBuiltins: (registry: {
    get(id: string): Plugin | null;
    register(p: Plugin): unknown;
}) => void;

/** Fetch the lip-sync server config for an avatar by its content hash. */
declare const fetchLipSyncConfig: (serverUrl: string, contentHash: string) => Promise<LipSyncServerConfig | null>;
/** Fetch the actions server config for an avatar by its content hash. */
declare const fetchActionsConfig: (serverUrl: string, contentHash: string) => Promise<ActionConfig[] | null>;
/**
 * Build a per-frame openness map (0..1) for the talk range from keyframes.
 * `keyframes` is a list of `[absoluteFrameIndex, openness]` pairs. The result
 * is indexed by `(frameIndex - talkLow)`.
 */
declare const buildOpennessMap: (keyframes: [number, number][] | undefined, talkLow: number, talkHigh: number) => number[];

/**
 * Synthesize `text` via a cloud TTS `provider`. Throws for unknown providers
 * or on HTTP errors. Returns a playable object-URL.
 */
declare const professionalTTSRequest: (text: string, provider: string, config?: Partial<TTSConfig>) => Promise<TTSResult>;

declare class WakeWordEngine implements WakeWordEngineLike {
    private session;
    private audioContext;
    private stream;
    private processor;
    private source;
    private isListening;
    private threshold;
    private onDetect;
    private onError;
    private onScore;
    private audioBuffer;
    /** Optional path where the ort .wasm files are served from. */
    wasmPaths: string | undefined;
    /** Load the ONNX wake-word model from a URL. */
    loadModel(modelPath?: string, options?: {
        wasmPaths?: string;
    }): Promise<unknown>;
    isModelLoaded(): boolean;
    isCurrentlyListening(): boolean;
    /** Start mic capture + the inference loop. */
    startListening(config: WakeWordStartConfig): Promise<boolean>;
    stopListening(): Promise<void>;
    dispose(): Promise<void>;
    private concat;
    private inference;
}
declare const getWakeWordEngine: () => WakeWordEngine;
/** True if onnxruntime-web can be imported in this environment. */
declare const isWakeWordSupported: () => Promise<boolean>;

interface PiperStatus {
    ready: boolean;
    modelCached: boolean;
    downloading: boolean;
    progress: number;
    error: string | null;
    warming: boolean;
}
interface PiperInitOptions {
    onProgress?: (pct: number) => void;
    onReady?: () => void;
}
interface PiperEngine {
    generate(text: string, voice: string | null, speakerId: number): Promise<{
        file: Blob;
    }>;
    destroy?(): void;
}
/**
 * Initialize the Piper engine with a model. Resolves as soon as the engine is
 * constructed; model download + warmup run in the background. Throws if the
 * optional deps are not installed.
 */
declare const initPiper: (modelUrl: string, modelConfigUrl?: string, options?: PiperInitOptions) => Promise<PiperEngine>;
/** Kick off init + warmup in the background (e.g. on mount). */
declare const preloadPiper: (modelUrl: string, modelConfigUrl?: string, options?: PiperInitOptions) => Promise<PiperEngine>;
/**
 * Synthesize text to audio. Blocks on warmup if called before it completes so
 * the first real synthesis returns valid audio.
 */
declare const piperSynthesize: (text: string, options?: {
    speakerId?: number;
}) => Promise<{
    audioUrl: string;
    blob: Blob;
}>;
declare const getPiperStatus: () => PiperStatus;
declare const checkPiperStatus: () => PiperStatus;
declare const disposePiper: () => void;

interface ParsedHotkey {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    key: string;
}
/** Parse a hotkey string into modifier flags + base key. Returns null if no key. */
declare const parseHotkey: (hotkeyString?: string | null) => ParsedHotkey | null;
/** True if a keyboard event matches a parsed hotkey (modifiers + key). */
declare const matchesHotkey: (event: KeyboardEvent, parsed: ParsedHotkey | null) => boolean;

interface ActionAudioHandle {
    cancel: () => void;
}
/**
 * Play action audio from a base64 string (with or without a `data:` prefix).
 * When `delayMs > 0`, playback is deferred and the returned handle cancels the
 * pending timer too. Returns null when there is nothing to play (or no DOM Audio).
 */
declare const playActionAudio: (audioBase64?: string | null, delayMs?: number) => ActionAudioHandle | null;

interface OptimalSpeeds {
    idle: number;
    talk: number;
}
/**
 * Compute idle/talk speed multipliers from the avatar fps. Higher fps clips
 * play back faster so they don't look sluggish.
 */
declare const calcSpeeds: (fps: number) => OptimalSpeeds;
/** @deprecated Alias of {@link calcSpeeds}, kept for parity with older code. */
declare const calculateOptimalSpeeds: (fps: number) => OptimalSpeeds;

declare const getCachedAvatar: (url: string) => Promise<AniaAvatarData | null>;
declare const setCachedAvatar: (url: string, data: AniaAvatarData, isEncrypted?: boolean) => Promise<void>;
declare const deleteCachedAvatar: (url: string) => Promise<void>;
declare const clearAvatarCache: () => Promise<void>;
interface CacheStats {
    count: number;
    size: number;
    sizeFormatted: string;
}
declare const getCacheStats: () => Promise<CacheStats>;
/** A namespaced object exposing the whole cache API (re-exported as `AvatarCache`). */
declare const AvatarCache: {
    readonly get: (url: string) => Promise<AniaAvatarData | null>;
    readonly set: (url: string, data: AniaAvatarData, isEncrypted?: boolean) => Promise<void>;
    readonly delete: (url: string) => Promise<void>;
    readonly clear: () => Promise<void>;
    readonly stats: () => Promise<CacheStats>;
};

declare const DEFAULT_LOCALE = "pt-BR";
declare const FALLBACK_LOCALE = "en";
/** All locale codes that ship with the library (e.g. ['en','pt-BR','es',...]). */
declare function availableLocales(): string[];
/** True if a locale table is bundled for `locale`. */
declare function hasLocale(locale: string): boolean;
/** Resolve a single string by key for a locale. Returns the key if unmatched. */
declare function getString(key: string, locale?: string, opts?: {
    vars?: I18nVars;
    override?: MessagesOverride;
}): string;
/** Resolve a list-valued key (e.g. 'greetings', 'waiting'). */
declare function getStringList(key: string, locale?: string, opts?: {
    override?: MessagesOverride;
}): string[];
/** Build a translator bound to one locale + optional override table. */
declare function createTranslator(locale?: string, override?: MessagesOverride): Translator;

export { ALPHA, ARTICULATE_HEAD_DIMS, ARTICULATE_MOUTH_DIMS, type ActionAudioHandle, type ActionConfig, type ActionInfo, type AffineGains, type AffineParams, type AniaAnimationData, type AniaAvatarData, AniaPlayer, type AniaPlayerInstance, type AniaPlayerRenderOptions, AnimationController, type AnimationControllerConfig, AvatarCache, BLENDSHAPE_NAMES, BLINK_DETOUR_MAX_DELTA, BLINK_DETOUR_TICKS, BLINK_PITCH_EDGES, BLINK_YAW_EDGES, BLOCKERS, BREATHING_COST_BONUS, BREATHING_DWELL_TICKS, BROW_DIVISOR, BROW_GATE_MIN_MAPPING_VERSION, BROW_MAPPING_VERSION, BROW_NEUTRAL, BUILTIN_PLUGINS, BlinkDetour, CHANNEL_LABEL, COMMAND_LIST, CROSSFADE_COST, CROSSFADE_MODES, CROSSFADE_MS, CROSSFADE_TICKS, CUT_BIAS_SLACK, CUT_COST_CLIP, CUT_COST_THRESHOLD, CUT_CROSSFADE_MS, CUT_C_JUMP, CUT_MAX_BRIDGE, CUT_MAX_EXPANSIONS, CUT_TIE_DECIMALS, type CacheStats, type CommandContext, type CommandDescriptor, type CommandResult, type Coverage, type CoverageGap, type CrossfadeMode, type CutBiasFn, type CutCostFn, type CutPlan, DEFAULT_AFFINE_GAINS, DEFAULT_LOCALE, DEFAULT_MATCHER_OPTIONS, DEFAULT_SMOOTH_CUT_OPTIONS, DEFAULT_SUTIL_OPTIONS, DESCRIPTOR_VERSION, DIM_GROUP, DIM_INDEX, DIM_NAMES, DIM_VALID_DEFAULT, EDGE, ENGINE_LEGACY, ENGINE_MATCHER, Emitter, type EngineMode, FACE_GROUPS, FALLBACK_LOCALE, FPS_CLAMP_DEFAULT, FPS_FALLBACK, FRAME_POOLS, FRAME_POOL_ALL, FRAME_POOL_LEGACY, F_BROW_L, F_BROW_R, F_CHEEK_L, F_CHEEK_R, F_EYE_L, F_EYE_L_LIDS, F_EYE_R, F_EYE_R_LIDS, F_IRIS_L, F_IRIS_R, F_LIP_PAIRS, F_MOUTH_CORNERS, F_NOSE_TIP, type FlatLandmarks, type FpsClampOption, type FpsClampWindow, type FrameIntervalArgs, FramePacer, type FramePixels, type FramePool, GAP_PRESET, GRAY, GROUP_NAMES, GROUP_PARAMS, G_BODY, G_BROWS, G_EYES, G_HAND_L, G_HAND_R, G_HEAD, G_MOUTH, G_RESERVED, HEAD_DROP_PER_W, HEAD_FALLBACK, HEAD_FEATHER_FRAC, HEAD_FEATHER_MIN_OF_HEAD, HEAD_RX_PER_W, HEAD_RY_PER_W, HEAD_YAW_DEG_PER_UNIT, HOLD_DIMS, HOLD_DIM_MOUTH_OPEN, H_MCP_MID, H_TIPS, H_WRIST, type HeadRegion, type I18nVars, INTENSITY_MAX, INTENSITY_MIN, KIND_HUB, KIND_KNN, KIND_PRED, KIND_SUCC, LEVELS, LEVEL_EXPRESSIVE, LEVEL_MIRROR, LEVEL_MOUTH_SOURCE, LEVEL_OFF, LEVEL_ORDER, LEVEL_PRESENCE, LEVEL_UI, type LandmarkPoint, type Landmarks, type LevelAffine, type LevelCard, type LevelComfortDefaults, type LevelGain, type LevelSpec, LipAnimator, type LipAnimatorBranch, type LipAnimatorOptions, type LipAnimatorStepArgs, LipSyncAnalyser, type LipSyncAnalyserOptions, type LipSyncConfig, LipSyncDsp, type LipSyncDspOptions, type LipSyncDspReading, type LipSyncServerConfig, type LipSyncSustainStyle, type LoadSource, MAX_DT_MS, MIC_TALK_CLOSE_TICKS, MIC_TALK_OPEN_TICKS, MIC_TALK_THRESHOLD, MIN_DT_MS, MIRROR_NEGATE, MIRROR_SWAP, MODE_DECAY, MODE_IDLE, MODE_LIVE, MOUTH_HANDOVER_MS, MOUTH_SOURCES, MatcherError, type MatcherOptions, type MessagesOverride, MicTalkBridge, type MocapCapabilitiesReport, type MocapCaps, type MocapComfort, type MocapComfortInput, type MocapConfigureInput, type MocapCrossfadeState, type MocapDebugReport, type MocapIndex, type MocapLevel, type MocapWarning, type MocapWarningReport, type MocapWarpState, type MotionGraph, type MotionGraphOptions, MotionMatcher, type MouthSource, NDIMS, NEUTRAL, NUSED, type NativeFps, OneEuroVector, type OptimalSpeeds, PLUGIN_KINDS, POSE_GROUPS, PRESETS, P_EAR_L, P_EAR_R, P_ELBOW_L, P_ELBOW_R, P_EYE_L, P_EYE_R, P_NOSE, P_SHOULDER_L, P_SHOULDER_R, P_WRIST_L, P_WRIST_R, type ParsedHotkey, type PiperInitOptions, type PiperStatus, type PlayerEventMap, type PlayerEventName, type PlayerOptions, type PlayerPosition, type Plugin, type PluginContext, type PluginKind, PluginRegistry, type PluginRegistryLike, type PluginSettingField, type PoseDescriptorMessage, type PosesBank, type PosesIndexOptions, RETARGET, RETARGET_GAIN_MAX, RETARGET_GAIN_MIN, RETARGET_OVERSHOOT, type ResolvedAffine, type ResolvedOptions, SCHEMA_COVERAGE, SCHEMA_POSES, SEQ_IDLE, SEQ_OTHER, SEQ_TALK, SIG_LEN, SMOOTHING_MAX, SMOOTHING_MIN, STRINGS, type STTEngine, type STTProvider, STT_PROVIDER_TO_PLUGIN, type Sequence, SmoothCut, type SmoothCutConfigureInput, type SmoothCutOptions, type SpeechRecognitionOptions, SpeechRecognizer, type StartPointHintFn, type StepResult, SutilDriver, type SutilOptions, TARGET_BINS, type TTSConfig, type TTSEngine, type TTSProvider, type TTSResult, TTS_PROVIDER_TO_PLUGIN, type Translator, WARNERS, WEIGHTS, W_ALPHA, W_EDGE, W_GRAY, WakeWordEngine, type WakeWordEngineLike, type WakeWordStartConfig, type WarpRegion, actionAudioPlugin, allPairsSq, allowsCameraMouth, applyMirror, attachReach, availableLocales, blank, boxResizeRgba, buildControllerConfig, buildCoverage, buildGraphFromDistances, buildMotionGraph, buildOpennessMap, buildPosesIndex, buildReach, calcSpeeds, calculateOptimalSpeeds, checkPiperStatus, clearAvatarCache, computeDescriptor, createAniaPlayer, createTranslator, crossfadeAlpha, cutCostMean, decryptAniaFile, defaultComfort, deleteCachedAvatar, dimGainFor, disposePiper, engineOf, executeCommand, featherNorm, fetchActionsConfig, fetchLipSyncConfig, findClosedFrame, fpsFromIntervalMs, frameIntervalMs, framePoolOf, frameSeq, gainsFromOptions, getCacheStats, getCachedAvatar, getDefaultRegistry, getPiperStatus, getString, getStringList, getWakeWordEngine, groupVector, hasLocale, headDegrees, headRegionFromFrame, headRegionKey, initPiper, installPostMessageControl, isIdentity, isWakeWordSupported, levelActive, levelCards, matcherCameraMouth, matcherKwargs, matchesHotkey, normalizeFpsClamp, oneEuroMinCutoff, paramsForHead, paramsFromResidual, parseCommandLine, parseHotkey, piperSynthesize, playActionAudio, preloadPiper, probeCaps, professionalTTSRequest, pyRound, regionAlpha, regionAlphaAt, regionBox, registerBuiltins, resolveNativeFps, resolveOptions, sequencesFromRanges, serializeComfort, setCachedAvatar, shouldCrossfade, signature, sttBrowserPlugin, sttGooglePlugin, text, ttsAzurePlugin, ttsBrowserPlugin, ttsElevenLabsPlugin, ttsGooglePlugin, ttsPiperPlugin, ttsTiktokPlugin, validatePlugin, wakeWordPlugin };
