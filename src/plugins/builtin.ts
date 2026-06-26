// Built-in plugins — wrap the engine's existing subsystems (tts-api providers,
// Piper ONNX, browser/Google STT, action audio) as registered Plugin objects.
//
// Each TTS/STT provider is a separate plugin so a host can pick the active one
// with `registry.setActive('tts', 'tts-piper')`, mirroring the desktop player.
//
// Ported from the web-player's `plugins/builtins.js`.

import type { Plugin, PluginContext, TTSEngine } from '../types';
import { professionalTTSRequest } from '../services/tts-api';
import { playActionAudio } from '../utils/action-renderer';

// ---------------------------------------------------------------------------
// TTS providers
// ---------------------------------------------------------------------------

const makeApiTtsEngine = (providerId: string, ctx?: PluginContext): TTSEngine => {
  const config = (ctx && ctx.config) || {};
  let current: HTMLAudioElement | null = null;
  return {
    async synthesize(text: string, options: Record<string, unknown> = {}) {
      return professionalTTSRequest(text, providerId, { ...config, ...options });
    },
    async speak(text: string, options: Record<string, unknown> = {}) {
      const { audioUrl } = await professionalTTSRequest(text, providerId, { ...config, ...options });
      if (current) {
        try {
          current.pause();
        } catch {
          /* ignore */
        }
      }
      const audio = new Audio(audioUrl);
      current = audio;
      audio.addEventListener('ended', () => URL.revokeObjectURL(audioUrl), { once: true });
      await audio.play();
      return audio;
    },
    stop() {
      if (current) {
        try {
          current.pause();
        } catch {
          /* ignore */
        }
        current = null;
      }
    },
    cleanup() {
      this.stop?.();
    },
  };
};

const apiProvider = (
  id: string,
  label: string,
  providerId: string,
  description: string
): Plugin => ({
  id,
  name: label,
  version: '1.0.0',
  kind: 'tts',
  builtin: true,
  description,
  createEngine: (ctx) => makeApiTtsEngine(providerId, ctx),
});

export const ttsBrowserPlugin: Plugin = {
  id: 'tts-browser',
  name: 'Browser TTS (Web Speech)',
  version: '1.0.0',
  kind: 'tts',
  builtin: true,
  description: 'window.speechSynthesis — no key, no network.',
  createEngine: (): TTSEngine => ({
    async speak(text: string, options: Record<string, unknown> = {}) {
      if (typeof window === 'undefined' || !window.speechSynthesis) return null;
      if (options.cancelPrevious) window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = (options.lang as string) || 'pt-BR';
      u.rate = (options.rate as number) || 1;
      u.pitch = (options.pitch as number) || 1;
      u.volume = (options.volume as number) ?? 1;
      if (options.voice) u.voice = options.voice as SpeechSynthesisVoice;
      window.speechSynthesis.speak(u);
      return u;
    },
    stop() {
      if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    },
  }),
};

export const ttsTiktokPlugin = apiProvider(
  'tts-tiktok',
  'TikTok TTS',
  'tiktok',
  'Keyless TikTok voices (br_003/br_005).'
);
export const ttsElevenLabsPlugin = apiProvider(
  'tts-elevenlabs',
  'ElevenLabs',
  'elevenlabs',
  'ElevenLabs multilingual (needs API key).'
);
export const ttsGooglePlugin = apiProvider(
  'tts-google',
  'Google Cloud TTS',
  'google',
  'Google Cloud Text-to-Speech (needs API key).'
);
export const ttsAzurePlugin = apiProvider(
  'tts-azure',
  'Azure TTS',
  'azure',
  'Azure Cognitive Services Speech (needs API key).'
);

/** Piper on-device ONNX provider (optional deps loaded lazily). */
export const ttsPiperPlugin: Plugin = {
  id: 'tts-piper',
  name: 'Piper (on-device ONNX)',
  version: '1.0.0',
  kind: 'tts',
  builtin: true,
  description: 'Browser-side neural TTS via piper-tts-web + onnxruntime-web (optional deps).',
  async init(ctx) {
    const cfg = (ctx && (ctx.config as Record<string, string>)) || {};
    if (cfg.piperModelUrl) {
      try {
        const { preloadPiper } = await import('../services/piper-tts');
        preloadPiper(cfg.piperModelUrl, cfg.piperModelConfigUrl).catch(() => {});
      } catch {
        /* optional dep missing; degrade */
      }
    }
  },
  createEngine: (ctx): TTSEngine => {
    const cfg = (ctx && (ctx.config as Record<string, unknown>)) || {};
    let current: HTMLAudioElement | null = null;
    return {
      async synthesize(text: string, options: Record<string, unknown> = {}) {
        const { initPiper, piperSynthesize } = await import('../services/piper-tts');
        if (cfg.piperModelUrl) {
          await initPiper(cfg.piperModelUrl as string, cfg.piperModelConfigUrl as string | undefined);
        }
        return piperSynthesize(text, {
          speakerId: (options.speakerId as number) ?? (cfg.piperSpeakerId as number),
        });
      },
      async speak(text: string, options: Record<string, unknown> = {}) {
        const { audioUrl } = await this.synthesize!(text, options);
        if (current) {
          try {
            current.pause();
          } catch {
            /* ignore */
          }
        }
        const audio = new Audio(audioUrl);
        current = audio;
        audio.addEventListener('ended', () => URL.revokeObjectURL(audioUrl), { once: true });
        await audio.play();
        return audio;
      },
      stop() {
        if (current) {
          try {
            current.pause();
          } catch {
            /* ignore */
          }
          current = null;
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// STT providers — thin descriptors; the active id selects the provider the
// host's SpeechRecognizer should drive (keeps the recognizer untouched).
// ---------------------------------------------------------------------------

export const sttBrowserPlugin: Plugin = {
  id: 'stt-browser',
  name: 'Browser STT (Web Speech)',
  version: '1.0.0',
  kind: 'stt',
  builtin: true,
  description: 'webkitSpeechRecognition — Chrome/Edge only, no key.',
  createEngine: () => ({ provider: 'browser' }),
};

export const sttGooglePlugin: Plugin = {
  id: 'stt-google',
  name: 'Google Cloud STT',
  version: '1.0.0',
  kind: 'stt',
  builtin: true,
  description: 'Google Cloud Speech-to-Text (needs API key).',
  createEngine: () => ({ provider: 'google' }),
};

// ---------------------------------------------------------------------------
// Wake-word built-in — wraps the ONNX WakeWordEngine singleton.
// ---------------------------------------------------------------------------

export const wakeWordPlugin: Plugin = {
  id: 'wakeword-onnx',
  name: 'Wake Word (OpenWakeWord ONNX)',
  version: '1.0.0',
  kind: 'wakeword',
  builtin: true,
  defaultEnabled: false,
  description: 'On-device wake word via onnxruntime-web (optional dep).',
  createEngine: async () => {
    const { getWakeWordEngine } = await import('../services/wake-word-engine');
    return getWakeWordEngine();
  },
} as Plugin;

// ---------------------------------------------------------------------------
// Action handler built-in — plays an action's bundled audio.
// ---------------------------------------------------------------------------

export const actionAudioPlugin: Plugin = {
  id: 'action-audio',
  name: 'Action Audio',
  version: '1.0.0',
  kind: 'action',
  builtin: true,
  description: "Plays an action config's base64 audio when the action fires.",
  createHandler: () => ({
    onAction(actionConfig: { audio_base64?: string; audio_delay_ms?: number }) {
      if (actionConfig && actionConfig.audio_base64) {
        return playActionAudio(actionConfig.audio_base64, actionConfig.audio_delay_ms || 0);
      }
      return null;
    },
  }),
};

/** Every built-in, in registration order. */
export const BUILTIN_PLUGINS: Plugin[] = [
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
];

/** Map a legacy `ttsProvider` string to its built-in plugin id. */
export const TTS_PROVIDER_TO_PLUGIN: Record<string, string> = {
  browser: 'tts-browser',
  tiktok: 'tts-tiktok',
  elevenlabs: 'tts-elevenlabs',
  google: 'tts-google',
  azure: 'tts-azure',
  piper: 'tts-piper',
};

/** Map a legacy `sttProvider` string to its built-in plugin id. */
export const STT_PROVIDER_TO_PLUGIN: Record<string, string> = {
  browser: 'stt-browser',
  google: 'stt-google',
};

/** Register all built-ins onto a registry (idempotent — skips existing ids). */
export const registerBuiltins = (registry: {
  get(id: string): Plugin | null;
  register(p: Plugin): unknown;
}): void => {
  for (const p of BUILTIN_PLUGINS) {
    if (!registry.get(p.id)) registry.register(p);
  }
};
