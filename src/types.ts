// ===========================================================================
// ania-avatar-core — shared type definitions
//
// Every public type lives here and is re-exported from `src/index.ts`. Wrapper
// libraries (Vue/Angular/Svelte/Web-Component) build against these.
// ===========================================================================

import type { FpsClampOption } from './utils/frame-rate';

// ----- Providers -----

/** Cloud/keyless TTS providers handled by the built-in tts-api service. */
export type TTSProvider = 'browser' | 'tiktok' | 'google' | 'azure' | 'elevenlabs' | 'piper';

/** STT providers handled by the built-in speech-recognition helper. */
export type STTProvider = 'browser' | 'google';

/** Lip-sync sustain shaping while a vowel is held. */
export type LipSyncSustainStyle = 'hold' | 'wiggle';

// ----- Avatar file data -----

/**
 * Decrypted `.ania` avatar payload. `video.frames` are base64 WebP strings.
 * `animation` carries the idle/talk ranges + speeds the renderer drives.
 */
export interface AniaAvatarData {
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
export interface AniaAnimationData {
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

// ----- Animation controller config (snake_case, normalized) -----

/** Normalized config consumed by {@link AnimationController}. */
export interface AnimationControllerConfig {
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

  // ----- Frame pacing -----
  //
  // The controller used to hardcode 30 fps and divide it by an arbitrary speed
  // multiplier, so a host passing `talkSpeed: 5.3` asked for ~159 fps. These
  // four fields replace that guess with the footage's real rate plus an
  // explicit window, and are the same names `ania-avatar-react` writes.

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

// ----- Actions -----

/**
 * A named clip that plays a sub-range of the avatar's frames at a given
 * speed/direction, optionally from a random start position, and optionally
 * plays a base64 audio clip. Mirrors the desktop player's action system.
 */
export interface ActionConfig {
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
export interface ActionInfo {
  id: string;
  name: string;
}

// ----- Lip sync -----

/** Advanced lip-sync knobs ported from the desktop player. */
export interface LipSyncConfig {
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
export interface LipSyncServerConfig {
  lips_sync_keyframes?: [number, number][];
  lips_sync_sync_intensity?: number;
  lips_sync_responsiveness?: number;
  lips_sync_sustain_style?: LipSyncSustainStyle;
  lips_sync_wiggle_speed?: number;
}

// ----- TTS config -----

export interface TTSConfig {
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

export interface TTSResult {
  audioUrl: string;
  duration: number;
}

// ----- Player options + instance -----

/** Visual anchor for the player target (only used by wrappers if they want). */
export type PlayerPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

/** Options passed to {@link createAniaPlayer}. */
export interface PlayerOptions {
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
export interface LoadSource {
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
export interface PlayerEventMap {
  load: AniaAvatarData;
  talkStart: void;
  talkEnd: void;
  actionStart: string;
  actionEnd: string;
  error: Error;
}

export type PlayerEventName = keyof PlayerEventMap;

/** Imperative handle returned by {@link createAniaPlayer}. */
export interface AniaPlayerInstance {
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
  configureLipsSync(
    enabled: boolean,
    intensity?: number,
    responsiveness?: number,
    opennessMap?: number[] | null,
    sustainStyle?: LipSyncSustainStyle,
    wiggleSpeed?: number
  ): void;
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
  readonly controller: import('./core/animation-controller').AnimationController | null;
  /** The `<canvas>` the engine renders to. */
  readonly canvas: HTMLCanvasElement;
  /** Subscribe to a player event. Returns an unsubscribe fn. */
  on<E extends PlayerEventName>(event: E, cb: (payload: PlayerEventMap[E]) => void): () => void;
  /** Unsubscribe a previously-registered listener. */
  off<E extends PlayerEventName>(event: E, cb: (payload: PlayerEventMap[E]) => void): void;
}

// ----- Plugins -----

export type PluginKind = 'tts' | 'stt' | 'wakeword' | 'action' | 'integration';

export const PLUGIN_KINDS: readonly PluginKind[] = ['tts', 'stt', 'wakeword', 'action', 'integration'];

export interface PluginContext {
  /** Per-subsystem config (e.g. the TTS config bag). */
  config?: Record<string, unknown>;
  /** The owning registry. */
  registry?: PluginRegistryLike;
  /** Optional logger; defaults to console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  [key: string]: unknown;
}

/** TTS engine produced by a `tts` plugin's `createEngine`. */
export interface TTSEngine {
  speak(text: string, options?: Record<string, unknown>): Promise<unknown> | unknown;
  synthesize?(text: string, options?: Record<string, unknown>): Promise<{ audioUrl: string; blob?: Blob }>;
  stop?(): void;
  cleanup?(): void;
}

/** STT engine / descriptor produced by an `stt` plugin's `createEngine`. */
export interface STTEngine {
  provider?: STTProvider | string;
  startListening?(options?: Record<string, unknown>): Promise<boolean>;
  stopListening?(): void;
  cleanup?(): void;
}

/** Wake-word engine shape produced by a `wakeword` plugin's `createEngine`. */
export interface WakeWordEngineLike {
  loadModel?(modelUrl?: string, options?: { wasmPaths?: string }): Promise<unknown>;
  startListening(config: WakeWordStartConfig): Promise<boolean>;
  stopListening(): void | Promise<void>;
  isModelLoaded?(): boolean;
  isCurrentlyListening?(): boolean;
  dispose?(): void | Promise<void>;
}

export interface WakeWordStartConfig {
  threshold: number;
  onDetect: (score?: number) => void;
  onError?: (e: Error) => void;
  onScore?: (n: number) => void;
}

/** A single settings field a host can render for a plugin. */
export interface PluginSettingField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'select';
  options?: { value: string; label: string }[];
  placeholder?: string;
  description?: string;
  default?: string | number | boolean;
}

/** A registrable plugin. Plain object — no class to extend. */
export interface Plugin {
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
export interface PluginRegistryLike {
  register(plugin: Plugin): () => void;
  get(id: string): Plugin | null;
  list(): Plugin[];
  getByKind(kind: PluginKind): Plugin[];
  setActive(kind: PluginKind, id: string): void;
  getActive(kind: PluginKind): Plugin | null;
}

// ----- Commands -----

export interface CommandContext {
  player?: AniaPlayerInstance | { play?: () => void; pause?: () => void; controller?: unknown };
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

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface CommandDescriptor {
  cmd: string;
  desc: string;
}

// ----- i18n -----

/** Variables for `{{var}}` interpolation. */
export type I18nVars = Record<string, string | number>;

/** Consumer override table: scalar keys -> string, list keys -> string[]. */
export type MessagesOverride = Record<string, string | string[]>;

export interface Translator {
  locale: string;
  t: (key: string, vars?: I18nVars) => string;
  list: (key: string) => string[];
}
