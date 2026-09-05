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

// ----- Lip-sync maths -----
//
// The DSP and the frame animator that turn an audio envelope into mouth
// movement. Exported so the wrappers — and the tests in `examples/` — can
// exercise them directly; the controller uses them internally either way.
export { LipSyncDsp, LipAnimator, findClosedFrame } from './lip-sync';
export type {
  LipSyncDspOptions,
  LipSyncDspReading,
  LipAnimatorOptions,
  LipAnimatorStepArgs,
  LipAnimatorBranch,
} from './lip-sync';

// ----- Frame pacing -----
export {
  FPS_CLAMP_DEFAULT,
  FPS_FALLBACK,
  normalizeFpsClamp,
  resolveNativeFps,
  frameIntervalMs,
  fpsFromIntervalMs,
  FramePacer,
} from './utils/frame-rate';
export type {
  FpsClampWindow,
  FpsClampOption,
  NativeFps,
  FrameIntervalArgs,
} from './utils/frame-rate';

// ----- Motion matching (Ania 2.0 mocap core) -----
export {
  DESCRIPTOR_VERSION,
  NDIMS,
  NUSED,
  G_HEAD,
  G_MOUTH,
  G_EYES,
  G_BROWS,
  G_BODY,
  G_HAND_L,
  G_HAND_R,
  G_RESERVED,
  GROUP_NAMES,
  FACE_GROUPS,
  POSE_GROUPS,
  DIM_NAMES,
  DIM_INDEX,
  DIM_GROUP,
  WEIGHTS,
  RETARGET,
  NEUTRAL,
  MIRROR_NEGATE,
  MIRROR_SWAP,
  F_NOSE_TIP,
  F_CHEEK_R,
  F_CHEEK_L,
  F_EYE_R,
  F_EYE_L,
  F_EYE_R_LIDS,
  F_EYE_L_LIDS,
  F_IRIS_R,
  F_IRIS_L,
  F_LIP_PAIRS,
  F_MOUTH_CORNERS,
  F_BROW_R,
  F_BROW_L,
  P_NOSE,
  P_EYE_L,
  P_EYE_R,
  P_EAR_L,
  P_EAR_R,
  P_SHOULDER_L,
  P_SHOULDER_R,
  P_ELBOW_L,
  P_ELBOW_R,
  P_WRIST_L,
  P_WRIST_R,
  H_WRIST,
  H_MCP_MID,
  H_TIPS,
  BLENDSHAPE_NAMES,
  blank,
  computeDescriptor,
  applyMirror,
  groupVector,
  headDegrees,
  GROUP_PARAMS,
  MIN_DT_MS,
  MAX_DT_MS,
  OneEuroVector,
  MODE_LIVE,
  MODE_DECAY,
  MODE_IDLE,
  SEQ_IDLE,
  SEQ_TALK,
  SEQ_OTHER,
  KIND_KNN,
  KIND_SUCC,
  KIND_PRED,
  KIND_HUB,
  MatcherError,
  DEFAULT_MATCHER_OPTIONS,
  MotionMatcher,
  // ----- index builders: poses.json / motion_graph.json / coverage.json, client-side
  GRAY,
  ALPHA,
  EDGE,
  W_GRAY,
  W_ALPHA,
  W_EDGE,
  SIG_LEN,
  pyRound,
  boxResizeRgba,
  signature,
  allPairsSq,
  buildGraphFromDistances,
  buildMotionGraph,
  SCHEMA_POSES,
  SCHEMA_COVERAGE,
  DIM_VALID_DEFAULT,
  TARGET_BINS,
  GAP_PRESET,
  PRESETS,
  sequencesFromRanges,
  frameSeq,
  buildPosesIndex,
  buildCoverage,
} from './motion-matcher';
export type {
  FlatLandmarks,
  LandmarkPoint,
  Landmarks,
  StepResult,
  MatcherOptions,
  PosesBank,
  MotionGraph,
  MocapIndex,
  PoseDescriptorMessage,
  FramePixels,
  MotionGraphOptions,
  Sequence,
  CoverageGap,
  Coverage,
  PosesIndexOptions,
} from './motion-matcher';

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
