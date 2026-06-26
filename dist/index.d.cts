declare class AnimationController {
    private config;
    private currentFrameIndex;
    private idleSpeed;
    private talkSpeed;
    private lastFrameTime;
    private frameInterval;
    private direction;
    isTalking: boolean;
    private actions;
    private activeAction;
    /** Fired when an action starts. */
    onActionStartCallback: ((id: string) => void) | null;
    /** Fired when an action completes naturally (reached the range end). */
    onActionCompleteCallback: ((id: string) => void) | null;
    /** Fired when an action is force-cancelled. */
    onActionCancelCallback: ((id: string) => void) | null;
    private lipSyncEnabled;
    private lipSyncIntensity;
    private lipSyncResponsiveness;
    private lipSyncSustainStyle;
    private lipSyncWiggleSpeed;
    private opennessMap;
    private envelope;
    private wigglePhase;
    /** Supplied by the audio path each frame; returns instantaneous openness 0..1. */
    getOpennessFn: (() => number) | null;
    constructor(config: AnimationControllerConfig, frameCount: number);
    private jumpToRandomStartPosition;
    setTalkingState(talking: boolean): void;
    setSpeeds(idleSpeed?: number, talkSpeed?: number): void;
    /** Set the idle animation speed multiplier. */
    setIdleSpeed(speed: number): void;
    /** Set the talk animation speed multiplier. */
    setTalkSpeed(speed: number): void;
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
     * Configure the advanced lip-sync. `opennessMap` maps a talk-range frame
     * offset to an openness value 0..1 (built via {@link buildOpennessMap}).
     */
    configureLipsSync(enabled: boolean, intensity?: number, responsiveness?: number, opennessMap?: number[] | null, sustainStyle?: LipSyncSustainStyle, wiggleSpeed?: number): void;
    isLipSyncEnabled(): boolean;
    getLipSyncEnvelope(): number;
    /**
     * Pick the talk-range frame whose mapped openness is closest to the target.
     * Falls back to linear interpolation across the talk range when no map.
     */
    private frameForOpenness;
    /**
     * Advance the animation. Returns the frame index to render, or -1 if it's
     * not yet time to update (throttled by speed). Call from a rAF loop with the
     * timestamp.
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

export { type ActionAudioHandle, type ActionConfig, type ActionInfo, type AniaAnimationData, type AniaAvatarData, AniaPlayer, type AniaPlayerInstance, type AniaPlayerRenderOptions, AnimationController, type AnimationControllerConfig, AvatarCache, BUILTIN_PLUGINS, COMMAND_LIST, type CacheStats, type CommandContext, type CommandDescriptor, type CommandResult, DEFAULT_LOCALE, Emitter, FALLBACK_LOCALE, type I18nVars, LipSyncAnalyser, type LipSyncAnalyserOptions, type LipSyncConfig, type LipSyncServerConfig, type LipSyncSustainStyle, type LoadSource, type MessagesOverride, type OptimalSpeeds, PLUGIN_KINDS, type ParsedHotkey, type PiperInitOptions, type PiperStatus, type PlayerEventMap, type PlayerEventName, type PlayerOptions, type PlayerPosition, type Plugin, type PluginContext, type PluginKind, PluginRegistry, type PluginRegistryLike, type PluginSettingField, type STTEngine, type STTProvider, STT_PROVIDER_TO_PLUGIN, type SpeechRecognitionOptions, SpeechRecognizer, type TTSConfig, type TTSEngine, type TTSProvider, type TTSResult, TTS_PROVIDER_TO_PLUGIN, type Translator, WakeWordEngine, type WakeWordEngineLike, type WakeWordStartConfig, actionAudioPlugin, availableLocales, buildControllerConfig, buildOpennessMap, calcSpeeds, calculateOptimalSpeeds, checkPiperStatus, clearAvatarCache, createAniaPlayer, createTranslator, decryptAniaFile, deleteCachedAvatar, disposePiper, executeCommand, fetchActionsConfig, fetchLipSyncConfig, getCacheStats, getCachedAvatar, getDefaultRegistry, getPiperStatus, getString, getStringList, getWakeWordEngine, hasLocale, initPiper, installPostMessageControl, isWakeWordSupported, matchesHotkey, parseCommandLine, parseHotkey, piperSynthesize, playActionAudio, preloadPiper, professionalTTSRequest, registerBuiltins, setCachedAvatar, sttBrowserPlugin, sttGooglePlugin, ttsAzurePlugin, ttsBrowserPlugin, ttsElevenLabsPlugin, ttsGooglePlugin, ttsPiperPlugin, ttsTiktokPlugin, validatePlugin, wakeWordPlugin };
