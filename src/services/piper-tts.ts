// Piper TTS browser engine wrapper.
//
// Uses `piper-tts-web` (+ `onnxruntime-web`) for on-device neural TTS in the
// browser. Both packages are OPTIONAL peer dependencies and are imported
// LAZILY — only on first real use — so the base bundle stays light and the rest
// of the engine works without them installed.
//
// ONNX inference runs in a Web Worker so the main thread stays responsive;
// engine warmup is fire-and-forget. Ported from the web-player's
// `services/piper-tts.js`.

export interface PiperStatus {
  ready: boolean;
  modelCached: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
  warming: boolean;
}

export interface PiperInitOptions {
  onProgress?: (pct: number) => void;
  onReady?: () => void;
}

/* Loose structural types for the optional deps (no hard import). */
interface PiperEngine {
  generate(text: string, voice: string | null, speakerId: number): Promise<{ file: Blob }>;
  destroy?(): void;
}
type PiperVoiceProvider = unknown;

let ort: { env: { wasm: { proxy: boolean; numThreads: number } } } | null = null;
let PiperWebEngine: (new (opts: Record<string, unknown>) => PiperEngine) | null = null;
let OnnxWebRuntime: (new (opts: Record<string, unknown>) => unknown) | null = null;
let OnnxWebWorkerRuntime: (new (opts: Record<string, unknown>) => unknown) | null = null;
let FetchProvider:
  | (new () => { destroy(): void; fetch(url: string): Promise<unknown> })
  | null = null;

let depsPromise: Promise<void> | null = null;

const ensureDeps = (): Promise<void> => {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const [ortMod, piperMod] = await Promise.all([
      import(/* @vite-ignore */ 'onnxruntime-web') as Promise<Record<string, unknown>>,
      import(/* @vite-ignore */ 'piper-tts-web') as Promise<Record<string, unknown>>,
    ]);
    ort = ((ortMod.default || ortMod) as typeof ort)!;
    PiperWebEngine = piperMod.PiperWebEngine as typeof PiperWebEngine;
    OnnxWebRuntime = piperMod.OnnxWebRuntime as typeof OnnxWebRuntime;
    OnnxWebWorkerRuntime = piperMod.OnnxWebWorkerRuntime as typeof OnnxWebWorkerRuntime;
    FetchProvider = piperMod.FetchProvider as typeof FetchProvider;
    // Disable ONNX proxy worker (clashes with piper's worker) + single-thread WASM.
    ort!.env.wasm.proxy = false;
    ort!.env.wasm.numThreads = 1;
  })().catch((err: unknown) => {
    depsPromise = null;
    const msg = err && (err as Error).message ? (err as Error).message : String(err);
    throw new Error(
      'piper-tts-web / onnxruntime-web are not installed. Add them to enable on-device ' +
        `TTS: npm i piper-tts-web onnxruntime-web. (${msg})`
    );
  });
  return depsPromise;
};

let engine: PiperEngine | null = null;
let initPromise: Promise<PiperEngine> | null = null;
let warmupPromise: Promise<void> | null = null;
let currentVoiceName: string | null = null;
let useWorkerRuntime = true;

let piperStatus: PiperStatus = {
  ready: false,
  modelCached: false,
  downloading: false,
  progress: 0,
  error: null,
  warming: false,
};

const setStatus = (patch: Partial<PiperStatus>): void => {
  piperStatus = { ...piperStatus, ...patch };
};

const buildVoiceProvider = (
  modelUrl: string,
  modelConfigUrl: string | undefined,
  options: PiperInitOptions
): PiperVoiceProvider => {
  const fetchProvider = new FetchProvider!();
  return {
    destroy: () => fetchProvider.destroy(),
    list: async () => [],
    fetch: async () => {
      setStatus({ progress: 10 });
      options.onProgress?.(10);
      const json = modelConfigUrl ? await fetchProvider.fetch(modelConfigUrl) : null;
      setStatus({ progress: 30 });
      options.onProgress?.(30);
      const blobUrl = await fetchProvider.fetch(modelUrl);
      setStatus({ progress: 90 });
      options.onProgress?.(90);
      return [json, blobUrl];
    },
  };
};

const buildEngine = (voiceProvider: PiperVoiceProvider): PiperEngine => {
  if (useWorkerRuntime) {
    try {
      return new PiperWebEngine!({
        onnxRuntime: new OnnxWebWorkerRuntime!({ numThreads: 1 }),
        voiceProvider,
      });
    } catch {
      useWorkerRuntime = false;
    }
  }
  return new PiperWebEngine!({
    onnxRuntime: new OnnxWebRuntime!({ numThreads: 1 }),
    voiceProvider,
  });
};

/**
 * Initialize the Piper engine with a model. Resolves as soon as the engine is
 * constructed; model download + warmup run in the background. Throws if the
 * optional deps are not installed.
 */
export const initPiper = async (
  modelUrl: string,
  modelConfigUrl?: string,
  options: PiperInitOptions = {}
): Promise<PiperEngine> => {
  if (engine && piperStatus.ready) return engine;
  if (initPromise) return initPromise;

  setStatus({ downloading: true, progress: 0, error: null, warming: true });

  initPromise = (async () => {
    try {
      await ensureDeps();
      const modelFileName = (modelUrl.split('/').pop() || 'voice').replace('.onnx', '');
      currentVoiceName = modelFileName;
      const voiceProvider = buildVoiceProvider(modelUrl, modelConfigUrl, options);
      engine = buildEngine(voiceProvider);

      warmupPromise = engine
        .generate(' ', currentVoiceName, 0)
        .then(() => {
          setStatus({
            ready: true,
            modelCached: true,
            downloading: false,
            progress: 100,
            warming: false,
          });
          options.onProgress?.(100);
          options.onReady?.();
        })
        .catch((err: unknown) => {
          setStatus({ downloading: false, error: (err as Error).message, warming: false });
          throw err;
        });

      return engine;
    } catch (err) {
      engine = null;
      initPromise = null;
      warmupPromise = null;
      setStatus({ downloading: false, error: (err as Error).message, warming: false });
      throw err;
    }
  })();

  return initPromise;
};

/** Kick off init + warmup in the background (e.g. on mount). */
export const preloadPiper = (
  modelUrl: string,
  modelConfigUrl?: string,
  options: PiperInitOptions = {}
): Promise<PiperEngine> => initPiper(modelUrl, modelConfigUrl, options);

/**
 * Synthesize text to audio. Blocks on warmup if called before it completes so
 * the first real synthesis returns valid audio.
 */
export const piperSynthesize = async (
  text: string,
  options: { speakerId?: number } = {}
): Promise<{ audioUrl: string; blob: Blob }> => {
  if (!engine) throw new Error('Piper TTS not initialized. Call initPiper() first.');
  if (warmupPromise) {
    try {
      await warmupPromise;
    } catch {
      /* surfaced by generate() below */
    }
  }
  const speakerId = options.speakerId ?? 0;
  const response = await engine.generate(text, currentVoiceName, speakerId);
  const blob = response.file;
  const audioUrl = URL.createObjectURL(blob);
  return { audioUrl, blob };
};

export const getPiperStatus = (): PiperStatus => ({ ...piperStatus });
export const checkPiperStatus = (): PiperStatus => ({ ...piperStatus });

export const disposePiper = (): void => {
  if (engine?.destroy) engine.destroy();
  engine = null;
  initPromise = null;
  warmupPromise = null;
  currentVoiceName = null;
  piperStatus = {
    ready: false,
    modelCached: false,
    downloading: false,
    progress: 0,
    error: null,
    warming: false,
  };
};
