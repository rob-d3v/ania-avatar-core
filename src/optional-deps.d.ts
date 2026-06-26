// Ambient declarations for the OPTIONAL peer dependencies. These packages are
// imported lazily (dynamic `import()`) and degrade gracefully when absent, so
// the base package must typecheck and build even when they are NOT installed.
// We type them as `any`-shaped modules; runtime code narrows what it uses.

declare module 'onnxruntime-web' {
  const mod: unknown;
  export default mod;
  export const env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  export class Tensor {
    constructor(type: string, data: Float32Array, dims: number[]);
    data: Float32Array;
  }
  export const InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<unknown>;
  };
}

declare module 'piper-tts-web' {
  const mod: unknown;
  export default mod;
  export const PiperWebEngine: new (opts: Record<string, unknown>) => unknown;
  export const OnnxWebRuntime: new (opts: Record<string, unknown>) => unknown;
  export const OnnxWebWorkerRuntime: new (opts: Record<string, unknown>) => unknown;
  export const FetchProvider: new () => { destroy(): void; fetch(url: string): Promise<unknown> };
}
