// ===========================================================================
// ania-avatar-core — public API
//
// Framework-agnostic engine for the Ania animated-avatar player. Mounts an
// avatar onto a <canvas>/container and drives lip-sync, actions, commands,
// plugins, TTS/STT/wake-word. Wrapper libraries (Vue/Angular/Svelte/Web
// Component) instantiate this and bind their reactive props/events to it.
// ===========================================================================

// ----- Core player -----
export { createAniaPlayer } from './core/create-player';
export { AniaPlayer, buildControllerConfig } from './core/ania-player';
export type { AniaPlayerRenderOptions } from './core/ania-player';
export { AnimationController } from './core/animation-controller';
export { Emitter } from './core/emitter';

// ----- Crypto -----
export { decryptAniaFile } from './crypto/ania-crypto';

// ----- Audio: lip-sync analyser + STT helper -----
export { LipSyncAnalyser } from './audio/lip-sync-analyser';
export type { LipSyncAnalyserOptions } from './audio/lip-sync-analyser';
export { SpeechRecognizer } from './audio/speech-recognition';
export type { SpeechRecognitionOptions } from './audio/speech-recognition';

// ----- Commands -----
export {
  executeCommand,
  parseCommandLine,
  installPostMessageControl,
  COMMAND_LIST,
} from './commands/commands';

// ----- Plugins -----
export { PluginRegistry, getDefaultRegistry, validatePlugin } from './plugins/registry';
export {
  BUILTIN_PLUGINS,
  registerBuiltins,
  TTS_PROVIDER_TO_PLUGIN,
  STT_PROVIDER_TO_PLUGIN,
  ttsBrowserPlugin,
  ttsTiktokPlugin,
  ttsElevenLabsPlugin,
  ttsGooglePlugin,
  ttsAzurePlugin,
  ttsPiperPlugin,
  sttBrowserPlugin,
  sttGooglePlugin,
  wakeWordPlugin,
  actionAudioPlugin,
} from './plugins/builtin';

// ----- Services: server config, TTS, wake word, Piper -----
export {
  fetchLipSyncConfig,
  fetchActionsConfig,
  buildOpennessMap,
} from './services/avatar-config-api';
export { professionalTTSRequest } from './services/tts-api';
export {
  WakeWordEngine,
  getWakeWordEngine,
  isWakeWordSupported,
} from './services/wake-word-engine';
export {
  initPiper,
  preloadPiper,
  piperSynthesize,
  getPiperStatus,
  checkPiperStatus,
  disposePiper,
} from './services/piper-tts';
export type { PiperStatus, PiperInitOptions } from './services/piper-tts';

// ----- Utils -----
export { parseHotkey, matchesHotkey } from './utils/hotkey-parser';
export type { ParsedHotkey } from './utils/hotkey-parser';
export { playActionAudio } from './utils/action-renderer';
export type { ActionAudioHandle } from './utils/action-renderer';
export { calcSpeeds, calculateOptimalSpeeds } from './utils/speed-calculator';
export type { OptimalSpeeds } from './utils/speed-calculator';
export {
  getCachedAvatar,
  setCachedAvatar,
  deleteCachedAvatar,
  clearAvatarCache,
  getCacheStats,
  AvatarCache,
} from './utils/avatar-cache';
export type { CacheStats } from './utils/avatar-cache';

// ----- i18n -----
export {
  getString,
  getStringList,
  createTranslator,
  availableLocales,
  hasLocale,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
} from './i18n/i18n';

// ----- Types (every public type) -----
export type {
  // providers
  TTSProvider,
  STTProvider,
  LipSyncSustainStyle,
  // avatar data
  AniaAvatarData,
  AniaAnimationData,
  AnimationControllerConfig,
  // actions
  ActionConfig,
  ActionInfo,
  // lip sync
  LipSyncConfig,
  LipSyncServerConfig,
  // tts
  TTSConfig,
  TTSResult,
  // player
  PlayerPosition,
  PlayerOptions,
  LoadSource,
  PlayerEventMap,
  PlayerEventName,
  AniaPlayerInstance,
  // plugins
  PluginKind,
  PluginContext,
  TTSEngine,
  STTEngine,
  WakeWordEngineLike,
  WakeWordStartConfig,
  PluginSettingField,
  Plugin,
  PluginRegistryLike,
  // commands
  CommandContext,
  CommandResult,
  CommandDescriptor,
  // i18n
  I18nVars,
  MessagesOverride,
  Translator,
} from './types';

export { PLUGIN_KINDS } from './types';
