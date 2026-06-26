// Framework-free speech-to-text helper. Wraps the browser Web Speech API
// (webkitSpeechRecognition) and a Google Cloud STT fallback (MediaRecorder ->
// REST). De-Reactified port of the web-player's `useSpeechRecognition` hook.

import type { STTProvider } from '../types';

export interface SpeechRecognitionOptions {
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

// Loose structural type for the non-standard SpeechRecognition API.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

/**
 * A reusable STT controller. Call {@link startListening} to begin and
 * {@link stopListening} to end; transcript text arrives via the callbacks
 * passed in the options (or in the constructor).
 */
export class SpeechRecognizer {
  private opts: SpeechRecognitionOptions;
  private recognition: SpeechRecognitionLike | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private listening = false;

  constructor(opts: SpeechRecognitionOptions = {}) {
    this.opts = opts;
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Whether the browser Web Speech API is available. */
  static isBrowserSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  }

  /** Start listening. Returns true if recognition started. */
  async startListening(override: SpeechRecognitionOptions = {}): Promise<boolean> {
    const o = { ...this.opts, ...override };
    this.stopListening();
    if (o.sttProvider === 'google' && o.sttApiKey) return this.startGoogle(o);
    return this.startBrowser(o);
  }

  private startBrowser(o: SpeechRecognitionOptions): boolean {
    const w = window as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      o.onError?.(new Error('Web Speech API not supported'));
      return false;
    }

    const recognition = new Ctor();
    recognition.lang = o.sttLang || 'pt-BR';
    recognition.continuous = o.sttContinuous ?? false;
    recognition.interimResults = o.sttInterimResults ?? true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.listening = true;
      o.onStart?.();
    };
    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += piece + ' ';
        else interim += piece;
      }
      if (interim) o.onTranscriptChange?.(interim, false);
      if (final) {
        o.onTranscriptChange?.(final.trim(), true);
        o.onFinalTranscript?.(final.trim());
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        if (this.listening) o.onEnd?.();
        return;
      }
      this.listening = false;
      o.onError?.(new Error(event.error));
    };
    recognition.onend = () => {
      if (this.listening) o.onEnd?.();
      this.listening = false;
    };

    this.recognition = recognition;
    recognition.start();
    return true;
  }

  private async startGoogle(o: SpeechRecognitionOptions): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      this.audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.audioChunks.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Audio = String(reader.result).split(',')[1];
          const apiUrl =
            o.sttApiUrl || `https://speech.googleapis.com/v1/speech:recognize?key=${o.sttApiKey}`;
          try {
            const response = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                config: {
                  encoding: 'WEBM_OPUS',
                  sampleRateHertz: 48000,
                  languageCode: o.sttLang || 'pt-BR',
                  enableAutomaticPunctuation: true,
                },
                audio: { content: base64Audio },
              }),
            });
            if (!response.ok) throw new Error(`Google STT error: ${response.status}`);
            const data = (await response.json()) as {
              results?: { alternatives: { transcript: string }[] }[];
            };
            const transcript = data.results?.[0]?.alternatives?.[0]?.transcript;
            if (transcript) o.onFinalTranscript?.(transcript);
            o.onEnd?.();
          } catch (err) {
            o.onError?.(err as Error);
          }
        };
        stream.getTracks().forEach((t) => t.stop());
        this.listening = false;
      };

      this.mediaRecorder = mediaRecorder;
      mediaRecorder.start();
      this.listening = true;
      o.onStart?.();
      return true;
    } catch (err) {
      o.onError?.(err as Error);
      return false;
    }
  }

  /** Stop listening and release resources. */
  stopListening(): void {
    this.listening = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
      this.recognition = null;
    }
    if (this.mediaRecorder) {
      try {
        this.mediaRecorder.stop();
      } catch {
        /* ignore */
      }
      this.mediaRecorder = null;
    }
  }
}
