// Cloud / keyless TTS providers. Returns an object-URL to the synthesized audio
// (the caller plays + optionally analyzes it). Ported from the Chrome
// extension's `lib/services/tts-api.ts`.
//
// Providers: tiktok (free), elevenlabs, google, azure. The `browser` and
// `piper` providers are handled elsewhere (Web Speech API / on-device ONNX).

import type { TTSConfig, TTSResult } from '../types';

const b64ToBlob = (b64: string, type: string): Blob => {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type });
};

/**
 * Synthesize `text` via a cloud TTS `provider`. Throws for unknown providers
 * or on HTTP errors. Returns a playable object-URL.
 */
export const professionalTTSRequest = async (
  text: string,
  provider: string,
  config: Partial<TTSConfig> = {}
): Promise<TTSResult> => {
  if (provider === 'tiktok') {
    const voiceId = config.voiceId || (config.gender === 'male' ? 'br_005' : 'br_003');
    const response = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceId }),
    });
    if (!response.ok) throw new Error(`TikTok TTS error: ${response.status}`);
    const data = (await response.json()) as { success?: boolean; data?: string };
    if (!data.success || !data.data) throw new Error('TikTok TTS: invalid response');
    const audioUrl = URL.createObjectURL(b64ToBlob(data.data, 'audio/mpeg'));
    return { audioUrl, duration: 0 };
  }

  if (provider === 'elevenlabs') {
    const voiceId = config.voiceId || 'pNInz6obpgDQGcFmaJgB'; // Adam (default)
    const model = config.model || 'eleven_multilingual_v2';
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': config.apiKey || '',
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!response.ok) throw new Error(`ElevenLabs API error: ${response.status}`);
    const audioUrl = URL.createObjectURL(await response.blob());
    return { audioUrl, duration: 0 };
  }

  if (provider === 'google') {
    const apiUrl =
      config.apiUrl ||
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${config.apiKey}`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: config.lang || 'pt-BR',
          name: config.voiceId || 'pt-BR-Standard-B',
          ssmlGender:
            config.gender === 'male' ? 'MALE' : config.gender === 'female' ? 'FEMALE' : 'NEUTRAL',
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: config.rate || 1.0,
          pitch: ((config.pitch || 1) - 1) * 20,
        },
      }),
    });
    if (!response.ok) throw new Error(`Google TTS API error: ${response.status}`);
    const data = (await response.json()) as { audioContent: string };
    const audioUrl = URL.createObjectURL(b64ToBlob(data.audioContent, 'audio/mpeg'));
    return { audioUrl, duration: 0 };
  }

  if (provider === 'azure') {
    const region = config.region || 'brazilsouth';
    const apiUrl =
      config.apiUrl || `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const voiceName = config.voiceId || 'pt-BR-AntonioNeural';
    const ssml = `<speak version='1.0' xml:lang='${config.lang || 'pt-BR'}'>
      <voice name='${voiceName}'>
        <prosody rate='${config.rate || 1.0}' pitch='${((config.pitch || 1) - 1) * 50}%'>
          ${text}
        </prosody>
      </voice>
    </speak>`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.apiKey || '',
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    });
    if (!response.ok) throw new Error(`Azure TTS API error: ${response.status}`);
    const audioUrl = URL.createObjectURL(await response.blob());
    return { audioUrl, duration: 0 };
  }

  throw new Error(`Unknown TTS provider: ${provider}`);
};
