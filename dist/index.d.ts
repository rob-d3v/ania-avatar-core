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
 * trailing visibility column for pose (stride 4). */
type FlatLandmarks = Float64Array | number[];
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
    private restFrame;
    private readonly seqOf;
    private readonly seqKindOf;
    private readonly kindIndex;
    private readonly cutAfter;
    private readonly offsets;
    private readonly to;
    private readonly cost;
    private readonly edgeCost;
    private readonly oneEuro;
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
    constructor(poses: PosesBank, graph?: MotionGraph | null, options?: Partial<MatcherOptions>, oneEuro?: OneEuroVector | null);
    /** The idle frame nearest the neutral pose — the DECAY-mode hub target. */
    getRestFrame(): number;
    reset(): void;
    pushPose(tMs: number, mask: number, values: ArrayLike<number>, norm?: 'raw' | 'cal'): void;
    setAudio(talking: boolean, envelope: number, intensity?: number): void;
    setMouthPolicy(policy: string): void;
    hasFreshPose(nowMs: number): boolean;
    private modeAt;
    private isNatural;
    private edgesOf;
    private transition;
    private scores;
    step(nowMs: number, currentFrame: number, isCached?: (j: number) => boolean): StepResult;
    /** Live target minus the chosen frame's descriptor (for the affine warp). */
    residual(frame: number): Float64Array;
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
}
/**
 * Descriptors + masks + sequences -> the `poses.json` object.
 * Mirrors `index.build_poses`.
 */
declare function buildPosesIndex(descriptors: ArrayLike<number>[], masks: ArrayLike<number>, seq: Sequence[], opts?: PosesIndexOptions): PosesBank;
/**
 * `poses.json` -> `coverage.json`: which marginal bins the bank actually covers,
 * which gaps need a calibration preset, and the overall coverage score.
 * Mirrors `index.build_coverage`.
 */
declare function buildCoverage(poses: PosesBank, minCount?: number): Coverage;

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
     * Load a pose bank (+ optional motion graph) built for this avatar.
     * `null` tears the mocap path down. Returns `false` (and logs) on a
     * `descriptorVersion` mismatch — the caller keeps playing normally.
     */
    configureMocap(index: MocapIndex | null): boolean;
    /** Feed one live pose sample (from a webcam/mocap capture source). */
    pushPose(desc: PoseDescriptorMessage): void;
    setMocapEnabled(enabled: boolean): void;
    /** Whether the mocap branch drove the last rendered frame. */
    isMocapActive(): boolean;
    getMocapMode(): string | null;
    getMocapDebug(): Record<string, number> | null;
    /** Live target minus the currently rendered frame's descriptor (affine warp input). */
    getMocapResidual(): number[] | null;
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
    configureMocap(index: MocapIndex | null): boolean;
    /** Feed one live pose sample from a webcam/mocap capture source. */
    pushPose(desc: PoseDescriptorMessage): void;
    /** Enable/disable the mocap-driven frame source. */
    setMocapEnabled(enabled: boolean): void;
    /** Whether the mocap branch drove the last rendered frame. */
    isMocapActive(): boolean;
    /** `'LIVE' | 'DECAY' | 'IDLE' | null` (null before the first mocap tick). */
    getMocapMode(): string | null;
    /** Debug counters from the last mocap step (E_best, S_best, candidates, ...). */
    getMocapDebug(): Record<string, number> | null;
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

export { ALPHA, type ActionAudioHandle, type ActionConfig, type ActionInfo, type AniaAnimationData, type AniaAvatarData, AniaPlayer, type AniaPlayerInstance, type AniaPlayerRenderOptions, AnimationController, type AnimationControllerConfig, AvatarCache, BLENDSHAPE_NAMES, BUILTIN_PLUGINS, COMMAND_LIST, type CacheStats, type CommandContext, type CommandDescriptor, type CommandResult, type Coverage, type CoverageGap, DEFAULT_LOCALE, DEFAULT_MATCHER_OPTIONS, DESCRIPTOR_VERSION, DIM_GROUP, DIM_INDEX, DIM_NAMES, DIM_VALID_DEFAULT, EDGE, Emitter, FACE_GROUPS, FALLBACK_LOCALE, FPS_CLAMP_DEFAULT, FPS_FALLBACK, F_BROW_L, F_BROW_R, F_CHEEK_L, F_CHEEK_R, F_EYE_L, F_EYE_L_LIDS, F_EYE_R, F_EYE_R_LIDS, F_IRIS_L, F_IRIS_R, F_LIP_PAIRS, F_MOUTH_CORNERS, F_NOSE_TIP, type FlatLandmarks, type FpsClampOption, type FpsClampWindow, type FrameIntervalArgs, FramePacer, type FramePixels, GAP_PRESET, GRAY, GROUP_NAMES, GROUP_PARAMS, G_BODY, G_BROWS, G_EYES, G_HAND_L, G_HAND_R, G_HEAD, G_MOUTH, G_RESERVED, H_MCP_MID, H_TIPS, H_WRIST, type I18nVars, KIND_HUB, KIND_KNN, KIND_PRED, KIND_SUCC, type LandmarkPoint, type Landmarks, LipAnimator, type LipAnimatorBranch, type LipAnimatorOptions, type LipAnimatorStepArgs, LipSyncAnalyser, type LipSyncAnalyserOptions, type LipSyncConfig, LipSyncDsp, type LipSyncDspOptions, type LipSyncDspReading, type LipSyncServerConfig, type LipSyncSustainStyle, type LoadSource, MAX_DT_MS, MIN_DT_MS, MIRROR_NEGATE, MIRROR_SWAP, MODE_DECAY, MODE_IDLE, MODE_LIVE, MatcherError, type MatcherOptions, type MessagesOverride, type MocapIndex, type MotionGraph, type MotionGraphOptions, MotionMatcher, NDIMS, NEUTRAL, NUSED, type NativeFps, OneEuroVector, type OptimalSpeeds, PLUGIN_KINDS, POSE_GROUPS, PRESETS, P_EAR_L, P_EAR_R, P_ELBOW_L, P_ELBOW_R, P_EYE_L, P_EYE_R, P_NOSE, P_SHOULDER_L, P_SHOULDER_R, P_WRIST_L, P_WRIST_R, type ParsedHotkey, type PiperInitOptions, type PiperStatus, type PlayerEventMap, type PlayerEventName, type PlayerOptions, type PlayerPosition, type Plugin, type PluginContext, type PluginKind, PluginRegistry, type PluginRegistryLike, type PluginSettingField, type PoseDescriptorMessage, type PosesBank, type PosesIndexOptions, RETARGET, SCHEMA_COVERAGE, SCHEMA_POSES, SEQ_IDLE, SEQ_OTHER, SEQ_TALK, SIG_LEN, type STTEngine, type STTProvider, STT_PROVIDER_TO_PLUGIN, type Sequence, type SpeechRecognitionOptions, SpeechRecognizer, type StepResult, TARGET_BINS, type TTSConfig, type TTSEngine, type TTSProvider, type TTSResult, TTS_PROVIDER_TO_PLUGIN, type Translator, WEIGHTS, W_ALPHA, W_EDGE, W_GRAY, WakeWordEngine, type WakeWordEngineLike, type WakeWordStartConfig, actionAudioPlugin, allPairsSq, applyMirror, availableLocales, blank, boxResizeRgba, buildControllerConfig, buildCoverage, buildGraphFromDistances, buildMotionGraph, buildOpennessMap, buildPosesIndex, calcSpeeds, calculateOptimalSpeeds, checkPiperStatus, clearAvatarCache, computeDescriptor, createAniaPlayer, createTranslator, decryptAniaFile, deleteCachedAvatar, disposePiper, executeCommand, fetchActionsConfig, fetchLipSyncConfig, findClosedFrame, fpsFromIntervalMs, frameIntervalMs, frameSeq, getCacheStats, getCachedAvatar, getDefaultRegistry, getPiperStatus, getString, getStringList, getWakeWordEngine, groupVector, hasLocale, headDegrees, initPiper, installPostMessageControl, isWakeWordSupported, matchesHotkey, normalizeFpsClamp, parseCommandLine, parseHotkey, piperSynthesize, playActionAudio, preloadPiper, professionalTTSRequest, pyRound, registerBuiltins, resolveNativeFps, sequencesFromRanges, setCachedAvatar, signature, sttBrowserPlugin, sttGooglePlugin, ttsAzurePlugin, ttsBrowserPlugin, ttsElevenLabsPlugin, ttsGooglePlugin, ttsPiperPlugin, ttsTiktokPlugin, validatePlugin, wakeWordPlugin };
