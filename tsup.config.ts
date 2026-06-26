import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  // ESM + CJS for npm consumers, IIFE/global for jsDelivr/unpkg <script> use.
  format: ['esm', 'cjs', 'iife'],
  globalName: 'AniaAvatarCore',
  dts: true,
  sourcemap: false,
  clean: true,
  minify: true,
  treeshake: true,
  target: 'es2020',
  outExtension({ format }) {
    if (format === 'cjs') return { js: '.cjs' };
    if (format === 'iife') return { js: '.global.js' };
    return { js: '.js' };
  },
  // Optional heavy deps are lazy dynamic-imported; never bundle them. They are
  // marked external at the esbuild level too so the no-code-split IIFE build
  // leaves the dynamic import() in place instead of trying to resolve it.
  external: ['onnxruntime-web', 'piper-tts-web'],
  esbuildOptions(opts) {
    opts.external = [...(opts.external ?? []), 'onnxruntime-web', 'piper-tts-web'];
  },
});
