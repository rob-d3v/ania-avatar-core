// Wake-word detection engine — openWakeWord chain on onnxruntime-web.
//
// Pipeline: getUserMedia(16 kHz mono) -> ScriptProcessor frames of 1280
// samples (80 ms) -> buffer 12 frames (~960 ms) -> single ONNX inference ->
// max output score; fire onDetect when score > threshold.
//
// `onnxruntime-web` is an OPTIONAL peer dependency, imported LAZILY. If it is
// not installed, `loadModel()` rejects with a clear, swallow-able error and the
// rest of the app is unaffected.

import type { WakeWordStartConfig, WakeWordEngineLike } from '../types';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 1280; // 80 ms at 16 kHz
const FRAMES_PER_INFERENCE = 12; // ~960 ms

// Minimal structural type for the bits of onnxruntime-web we touch — avoids a
// hard type dependency on the optional package.
interface OrtTensor {
  data: Float32Array | ArrayLike<number>;
}
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
}

let ortPromise: Promise<OrtModule> | null = null;

/** Lazy-load onnxruntime-web exactly once. Resolves to the ort module. */
const loadOrt = (): Promise<OrtModule> => {
  if (ortPromise) return ortPromise;
  ortPromise = import(/* @vite-ignore */ 'onnxruntime-web')
    .then((m: unknown) => {
      const mod = m as { default?: OrtModule } & OrtModule;
      return (mod.default || mod) as OrtModule;
    })
    .catch((err: unknown) => {
      ortPromise = null;
      const msg = err && (err as Error).message ? (err as Error).message : String(err);
      throw new Error(
        'onnxruntime-web is not installed. Add it to enable wake-word detection: ' +
          `npm i onnxruntime-web. (${msg})`
      );
    });
  return ortPromise;
};

export class WakeWordEngine implements WakeWordEngineLike {
  private session: OrtSession | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isListening = false;
  private threshold = 0.5;
  private onDetect: ((score: number) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private onScore: ((score: number) => void) | null = null;
  private audioBuffer: Float32Array[] = [];
  /** Optional path where the ort .wasm files are served from. */
  public wasmPaths: string | undefined = undefined;

  /** Load the ONNX wake-word model from a URL. */
  async loadModel(modelPath?: string, options: { wasmPaths?: string } = {}): Promise<unknown> {
    if (!modelPath) throw new Error('[WakeWord] loadModel requires a model URL.');
    const ort = await loadOrt();
    if (options.wasmPaths !== undefined) this.wasmPaths = options.wasmPaths;
    if (this.wasmPaths !== undefined) ort.env.wasm.wasmPaths = this.wasmPaths;
    try {
      ort.env.wasm.numThreads = 1;
    } catch {
      /* ignore */
    }
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return this.session;
  }

  isModelLoaded(): boolean {
    return this.session !== null;
  }

  isCurrentlyListening(): boolean {
    return this.isListening;
  }

  /** Start mic capture + the inference loop. */
  async startListening(config: WakeWordStartConfig): Promise<boolean> {
    if (this.isListening) return true;
    if (!this.session) {
      const err = new Error('Wake-word model not loaded. Call loadModel() first.');
      config.onError?.(err);
      return false;
    }

    this.threshold = config.threshold ?? 0.5;
    this.onDetect = config.onDetect || null;
    this.onError = config.onError || null;
    this.onScore = config.onScore || null;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const Ctx =
        (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ||
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
      this.audioContext = new Ctx({ sampleRate: SAMPLE_RATE });
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);

      this.processor.onaudioprocess = async (e) => {
        if (!this.isListening) return;
        const input = e.inputBuffer.getChannelData(0);
        this.audioBuffer.push(new Float32Array(input));

        if (this.audioBuffer.length >= FRAMES_PER_INFERENCE) {
          const full = this.concat(this.audioBuffer);
          this.audioBuffer = [];
          try {
            const score = await this.inference(full);
            this.onScore?.(score);
            if (score > this.threshold) this.onDetect?.(score);
          } catch (err) {
            this.onError?.(err as Error);
          }
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      this.isListening = true;
      return true;
    } catch (err) {
      this.onError?.(err as Error);
      await this.stopListening();
      return false;
    }
  }

  async stopListening(): Promise<void> {
    this.isListening = false;
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch {
        /* ignore */
      }
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        /* ignore */
      }
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.audioBuffer = [];
  }

  async dispose(): Promise<void> {
    await this.stopListening();
    this.session = null;
  }

  private concat(buffers: Float32Array[]): Float32Array {
    const total = buffers.reduce((s, b) => s + b.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const b of buffers) {
      out.set(b, offset);
      offset += b.length;
    }
    return out;
  }

  private async inference(audio: Float32Array): Promise<number> {
    const ort = await loadOrt();
    if (!this.session) throw new Error('[WakeWord] Model not loaded');
    const tensor = new ort.Tensor('float32', audio, [1, audio.length]);
    const feeds: Record<string, unknown> = {};
    feeds[this.session.inputNames[0]] = tensor;
    const results = await this.session.run(feeds);
    const output = results[this.session.outputNames[0]];
    const data = output.data;
    let max = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
    return max;
  }
}

/** Module singleton. */
let instance: WakeWordEngine | null = null;
export const getWakeWordEngine = (): WakeWordEngine => {
  if (!instance) instance = new WakeWordEngine();
  return instance;
};

/** True if onnxruntime-web can be imported in this environment. */
export const isWakeWordSupported = async (): Promise<boolean> => {
  try {
    await loadOrt();
    return true;
  } catch {
    return false;
  }
};
