// ===========================================================================
// motion-graph builder — the browser-side port of
// `AniaAPP/src/ania_player/plugins/mocap_webcam/graph.py`.
//
// Per frame a small visual signature is computed (32x32 luma over grey, 32x32
// alpha, 16x16 Sobel magnitude, weighted 0.5/0.3/0.2). The all-pairs squared
// distance is one GEMM. Costs are normalised by the median successor distance so
// `c = 1` means "as different as one natural playback step" and `c >= 6` is a
// visible jump. Output is CSR so the runtime never materialises the dense matrix.
//
// PURE: no DOM, no canvas, no `document`. The caller hands over raw RGBA pixel
// arrays, so this runs unchanged inside a Web Worker.
//
// PARITY: bit-exact against the Python reference, including
//   * float32 arithmetic in the signature (every op goes through Math.fround,
//     because numpy keeps the whole signature pipeline in float32);
//   * Pillow's BOX resampler — alpha-premultiplied, horizontal pass then
//     vertical, 22-bit fixed-point coefficients, uint8 intermediates (see
//     `boxResizeRgba`). Pillow's `Image.resize` converts RGBA -> RGBa before
//     resampling and back afterwards; skipping that would be wrong by up to
//     85/255 on frames with a varying alpha channel.
//   * Python's round-half-to-even `round(x, n)` on the emitted cost /
//     motionEnergy arrays (see `pyRound`).
// ===========================================================================

import { KIND_KNN, KIND_SUCC, KIND_PRED, KIND_HUB } from './matcher';
import type { MotionGraph } from './matcher';

export const GRAY = 32;
export const ALPHA = 32;
export const EDGE = 16;
export const W_GRAY = 0.5;
export const W_ALPHA = 0.3;
export const W_EDGE = 0.2;
export const SIG_LEN = GRAY * GRAY + ALPHA * ALPHA + EDGE * EDGE; // 2304

/** One frame's pixels. `ImageData` satisfies this shape as-is. */
export interface FramePixels {
  /** RGBA bytes, row-major, 4 per pixel. `ImageData.data` fits here. */
  data?: Uint8ClampedArray | Uint8Array | number[];
  /** Alias accepted for callers that name the buffer `rgba`. */
  rgba?: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

export interface MotionGraphOptions {
  /** Sequence id per frame (from `frameSeq`). Default: every frame in sequence 0. */
  frameSeq?: ArrayLike<number>;
  /** kNN edges per frame. Default 8. */
  k?: number;
  /** kNN edges above this normalised cost are dropped. Default 6. */
  edgeCostMax?: number;
  /** Costs are clipped here. Default 20. */
  costClip?: number;
  /** Force the rest frame; `null`/omitted derives it from motion energy. */
  restFrame?: number | null;
  /** Successor cost above this splits the sequence (a cut). Default 6. */
  cutThreshold?: number;
  /** 1 = single-frame distance, 2 = two-frame window (default). */
  window?: number;
  /** Copied into the output when given (the Python indexer adds it separately). */
  contentHash?: string;
  /** Called every `progressEvery` frames while signatures are computed. */
  onProgress?: (done: number, total: number) => void;
  progressEvery?: number;
}

const f32 = Math.fround;
const F_299 = f32(0.299);
const F_587 = f32(0.587);
const F_114 = f32(0.114);
const F_HALF = f32(0.5);
const F_ONE = f32(1.0);
const S_GRAY = f32(Math.sqrt(W_GRAY));
const S_ALPHA = f32(Math.sqrt(W_ALPHA));
const S_EDGE = f32(Math.sqrt(W_EDGE));

// --------------------------------------------------------------- python round
function incDecimalDigits(s: string): string {
  const out = s.split('');
  let i = out.length - 1;
  for (; i >= 0; i--) {
    if (out[i] === '9') {
      out[i] = '0';
    } else {
      out[i] = String.fromCharCode(out[i].charCodeAt(0) + 1);
      return out.join('');
    }
  }
  return '1' + out.join('');
}

/**
 * Python's `round(x, nd)`: round-half-to-EVEN on the exact binary value, then
 * back to the nearest double. `Math.round(x * 100) / 100` is not the same
 * function (it rounds halves up and re-introduces float error), and `toFixed`
 * rounds halves away from zero. Values such as 0.0625 -> 0.062 (not 0.063)
 * are exactly representable and do occur.
 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const ax = Math.abs(x);
  if (ax >= 1e21) return x;
  const s = ax.toFixed(Math.min(100, nd + 25));
  const dot = s.indexOf('.');
  const frac = s.slice(dot + 1);
  let digits = s.slice(0, dot) + frac.slice(0, nd);
  const rest = frac.slice(nd);
  const first = rest.charCodeAt(0) - 48;
  let up = false;
  if (first > 5) up = true;
  else if (first === 5) {
    if (/[1-9]/.test(rest.slice(1))) up = true;
    else up = (digits.charCodeAt(digits.length - 1) - 48) % 2 === 1;
  }
  if (up) digits = incDecimalDigits(digits);
  let out: string;
  if (nd > 0) {
    const pad = digits.padStart(nd + 1, '0');
    out = pad.slice(0, pad.length - nd) + '.' + pad.slice(pad.length - nd);
  } else {
    out = digits;
  }
  const v = Number(out);
  return neg ? -v : v;
}

// ------------------------------------------------------------- PIL BOX resize
const PRECISION_BITS = 22;
const PRECISION_SCALE = 1 << PRECISION_BITS; // 4194304
const PRECISION_HALF = 1 << (PRECISION_BITS - 1);

interface BoxCoeff {
  min: number;
  k: number[]; // 22-bit fixed-point weights, as Pillow normalises them
}

/** Pillow `precompute_coeffs` + `normalize_coeffs_8bpc` for the BOX filter. */
function boxCoeffs(inSize: number, outSize: number): BoxCoeff[] {
  const scale = inSize / outSize;
  const filterscale = scale < 1.0 ? 1.0 : scale;
  const support = 0.5 * filterscale;
  const invScale = 1.0 / filterscale;
  const out: BoxCoeff[] = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const w: number[] = [];
    let ww = 0.0;
    for (let x = 0; x < xmax; x++) {
      const t = (x + xmin - center + 0.5) * invScale;
      const v = t > -0.5 && t <= 0.5 ? 1.0 : 0.0;
      w.push(v);
      ww += v;
    }
    const k: number[] = [];
    for (let x = 0; x < xmax; x++) {
      const cv = ww !== 0.0 ? w[x] / ww : w[x];
      k.push(cv < 0 ? Math.trunc(-0.5 + cv * PRECISION_SCALE) : Math.trunc(0.5 + cv * PRECISION_SCALE));
    }
    out.push({ min: xmin, k });
  }
  return out;
}

function clip8(v: number): number {
  const s = Math.floor(v / PRECISION_SCALE);
  return s < 0 ? 0 : s > 255 ? 255 : s;
}

function muldiv255(a: number, b: number): number {
  const tmp = a * b + 128;
  return ((tmp >> 8) + tmp) >> 8;
}

/**
 * Pillow's `Image.resize(..., Image.Resampling.BOX)` for an 8-bit RGBA image,
 * reproduced byte for byte: premultiply (RGBA -> RGBa), horizontal pass,
 * vertical pass, unpremultiply (RGBa -> RGBA). Identical sizes short-circuit to
 * a copy exactly like Pillow does — which is why a 32x32 source survives the
 * premultiply round trip untouched.
 */
export function boxResizeRgba(
  src: Uint8ClampedArray | Uint8Array | number[],
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): Uint8ClampedArray {
  if (srcW === outW && srcH === outH) {
    const copy = new Uint8ClampedArray(outW * outH * 4);
    for (let i = 0; i < copy.length; i++) copy[i] = src[i];
    return copy;
  }
  // premultiply
  let cur = new Uint8ClampedArray(srcW * srcH * 4);
  for (let p = 0, n = srcW * srcH; p < n; p++) {
    const o = p * 4;
    const a = src[o + 3];
    cur[o] = muldiv255(src[o], a);
    cur[o + 1] = muldiv255(src[o + 1], a);
    cur[o + 2] = muldiv255(src[o + 2], a);
    cur[o + 3] = a;
  }
  let w = srcW;
  let h = srcH;
  if (w !== outW) {
    const cf = boxCoeffs(w, outW);
    const next = new Uint8ClampedArray(outW * h * 4);
    for (let y = 0; y < h; y++) {
      const rowIn = y * w * 4;
      const rowOut = y * outW * 4;
      for (let xx = 0; xx < outW; xx++) {
        const { min, k } = cf[xx];
        for (let c = 0; c < 4; c++) {
          let ss = PRECISION_HALF;
          for (let t = 0; t < k.length; t++) ss += cur[rowIn + (min + t) * 4 + c] * k[t];
          next[rowOut + xx * 4 + c] = clip8(ss);
        }
      }
    }
    cur = next;
    w = outW;
  }
  if (h !== outH) {
    const cf = boxCoeffs(h, outH);
    const next = new Uint8ClampedArray(w * outH * 4);
    for (let yy = 0; yy < outH; yy++) {
      const { min, k } = cf[yy];
      const rowOut = yy * w * 4;
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let ss = PRECISION_HALF;
          for (let t = 0; t < k.length; t++) ss += cur[(min + t) * w * 4 + x * 4 + c] * k[t];
          next[rowOut + x * 4 + c] = clip8(ss);
        }
      }
    }
    cur = next;
    h = outH;
  }
  // unpremultiply
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let p = 0, n = outW * outH; p < n; p++) {
    const o = p * 4;
    const a = cur[o + 3];
    if (a === 255 || a === 0) {
      out[o] = cur[o];
      out[o + 1] = cur[o + 1];
      out[o + 2] = cur[o + 2];
    } else {
      for (let c = 0; c < 3; c++) {
        const v = Math.trunc((255 * cur[o + c]) / a);
        out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    out[o + 3] = a;
  }
  return out;
}

// ----------------------------------------------------------------- signature
function pixelsOf(frame: FramePixels): Uint8ClampedArray | Uint8Array | number[] {
  const px = frame.data ?? frame.rgba;
  if (!px) throw new Error('buildMotionGraph: frame has neither `data` nor `rgba`');
  return px;
}

/**
 * Visual signature of one RGBA frame -> float32[SIG_LEN]. Every arithmetic step
 * is float32 (Math.fround) because numpy runs this whole pipeline in float32.
 */
export function signature(frame: FramePixels): Float32Array {
  const small = boxResizeRgba(pixelsOf(frame), frame.width, frame.height, GRAY, GRAY);
  const npx = GRAY * GRAY;
  const a = new Float32Array(npx);
  const g = new Float32Array(npx);
  for (let p = 0; p < npx; p++) {
    const o = p * 4;
    const r = f32(small[o] / 255.0);
    const gg = f32(small[o + 1] / 255.0);
    const bb = f32(small[o + 2] / 255.0);
    const al = f32(small[o + 3] / 255.0);
    // luma = 0.299 r + 0.587 g + 0.114 b, left to right, all float32
    const luma = f32(f32(f32(F_299 * r) + f32(F_587 * gg)) + f32(F_114 * bb));
    a[p] = al;
    // composite over grey 128: luma * a + 0.5 * (1 - a)
    g[p] = f32(f32(luma * al) + f32(F_HALF * f32(F_ONE - al)));
  }
  // Sobel-ish central differences on g, then a 2x2 mean down to EDGE x EDGE
  const mag = new Float32Array(npx);
  for (let y = 0; y < GRAY; y++) {
    for (let x = 0; x < GRAY; x++) {
      const gx = x >= 1 && x <= GRAY - 2 ? f32(g[y * GRAY + x + 1] - g[y * GRAY + x - 1]) : 0;
      const gy = y >= 1 && y <= GRAY - 2 ? f32(g[(y + 1) * GRAY + x] - g[(y - 1) * GRAY + x]) : 0;
      mag[y * GRAY + x] = f32(Math.sqrt(f32(f32(gx * gx) + f32(gy * gy))));
    }
  }
  const e = new Float32Array(EDGE * EDGE);
  for (let by = 0; by < EDGE; by++) {
    for (let bx = 0; bx < EDGE; bx++) {
      const r0 = 2 * by * GRAY + 2 * bx;
      const r1 = (2 * by + 1) * GRAY + 2 * bx;
      let acc = mag[r0];
      acc = f32(acc + mag[r0 + 1]);
      acc = f32(acc + mag[r1]);
      acc = f32(acc + mag[r1 + 1]);
      e[by * EDGE + bx] = f32(acc / 4);
    }
  }
  const sig = new Float32Array(SIG_LEN);
  for (let i = 0; i < npx; i++) sig[i] = f32(S_GRAY * g[i]);
  for (let i = 0; i < npx; i++) sig[npx + i] = f32(S_ALPHA * a[i]);
  for (let i = 0; i < EDGE * EDGE; i++) sig[2 * npx + i] = f32(S_EDGE * e[i]);
  return sig;
}

/** `||s_i - s_j||^2 / 1024` for all pairs (float64, symmetric, zero diagonal). */
export function allPairsSq(sigs: Float32Array[], dim = SIG_LEN): Float64Array {
  const n = sigs.length;
  const S = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) S[i * dim + j] = sigs[i][j];
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < dim; j++) s += S[i * dim + j] * S[i * dim + j];
    sq[i] = s;
  }
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let t = 0; t < dim; t++) dot += S[i * dim + t] * S[j * dim + t];
      let v = sq[i] + sq[j] - 2.0 * dot;
      if (!(v > 0)) v = 0;
      v /= 1024.0;
      D[i * n + j] = v;
      D[j * n + i] = v;
    }
    D[i * n + i] = 0;
  }
  return D;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const v = values.slice().sort((x, y) => x - y);
  const m = v.length;
  const h = m >> 1;
  return m % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

/**
 * Build the CSR motion graph from the all-pairs visual distance `V`
 * (row-major n x n). Mirrors `graph.build_graph`.
 */
export function buildGraphFromDistances(
  V: Float64Array,
  n: number,
  frameSeq: ArrayLike<number>,
  opts: MotionGraphOptions = {},
): MotionGraph {
  const k = opts.k ?? 8;
  const edgeCostMax = opts.edgeCostMax ?? 6.0;
  const costClip = opts.costClip ?? 20.0;
  const cutThreshold = opts.cutThreshold ?? 6.0;
  const windowN = opts.window ?? 2;

  const seq = new Int32Array(n);
  for (let i = 0; i < n; i++) seq[i] = Number(frameSeq[i]) | 0;

  const sameNext = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) sameNext[i] = seq[i + 1] === seq[i] ? 1 : 0;

  const nxt = new Int32Array(n);
  for (let i = 0; i < n; i++) nxt[i] = i;
  for (let i = 0; i < n - 1; i++) nxt[i] = sameNext[i] ? i + 1 : i;

  const V2 = new Float64Array(n * n);
  if (windowN === 2) {
    for (let i = 0; i < n; i++) {
      const ni = nxt[i];
      for (let j = 0; j < n; j++) V2[i * n + j] = 0.5 * (V[i * n + j] + V[ni * n + nxt[j]]);
    }
  } else {
    V2.set(V);
  }

  const succVals: number[] = [];
  for (let i = 0; i < n - 1; i++) if (sameNext[i]) succVals.push(V[i * n + i + 1]);
  let succMedian = succVals.length ? medianOf(succVals) : 1.0;
  if (succMedian <= 1e-12) succMedian = 1e-12;

  const C = new Float64Array(n * n);
  for (let t = 0; t < n * n; t++) {
    const c = V2[t] / succMedian;
    C[t] = c < costClip ? c : costClip;
  }

  const cutAfter = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) {
    if (sameNext[i] && C[i * n + i + 1] > cutThreshold) cutAfter[i] = 1;
  }
  const motionEnergy = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    if (sameNext[i]) motionEnergy[i] = V[i * n + i + 1] / succMedian;
  }

  let restFrame: number;
  if (opts.restFrame === undefined || opts.restFrame === null) {
    if (n === 0) {
      restFrame = 0;
    } else {
      // np.argmin(motionEnergy + (motionEnergy == 0) * 1e9) — first minimum wins
      let best = 0;
      let bestV = motionEnergy[0] + (motionEnergy[0] === 0 ? 1e9 : 0);
      for (let i = 1; i < n; i++) {
        const v = motionEnergy[i] + (motionEnergy[i] === 0 ? 1e9 : 0);
        if (v < bestV) {
          bestV = v;
          best = i;
        }
      }
      restFrame = best;
    }
  } else {
    restFrame = opts.restFrame | 0;
  }

  const edges: Map<number, [number, number]>[] = [];
  for (let i = 0; i < n; i++) edges.push(new Map());
  for (let i = 0; i < n; i++) {
    if (i + 1 < n && sameNext[i] && !cutAfter[i]) edges[i].set(i + 1, [C[i * n + i + 1], KIND_SUCC]);
    if (i - 1 >= 0 && sameNext[i - 1] && !cutAfter[i - 1]) edges[i].set(i - 1, [C[i * n + i - 1], KIND_PRED]);
  }
  // kNN — the k cheapest non-adjacent targets, symmetrised
  if (k > 0 && n > 1) {
    const kth = Math.min(k, n - 1);
    const row = new Float64Array(n);
    const order: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) row[j] = C[i * n + j];
      const lo = Math.max(0, i - 2);
      const hi = Math.min(n, i + 3);
      for (let j = lo; j < hi; j++) row[j] = Infinity;
      // ...but a near index from a *different* sequence is a real candidate
      for (let j = lo; j < hi; j++) if (seq[j] !== seq[i]) row[j] = C[i * n + j];
      row[i] = Infinity;
      for (let j = 0; j < n; j++) order[j] = j;
      // np.argpartition picks the `kth` smallest; ties there are arbitrary in
      // numpy, so we settle them by index for determinism.
      order.sort((x, y) => (row[x] - row[y]) || (x - y));
      for (let s = 0; s < kth; s++) {
        const j = order[s];
        const c = row[j];
        if (!Number.isFinite(c) || c > edgeCostMax) continue;
        if (!edges[i].has(j)) edges[i].set(j, [c, KIND_KNN]);
        if (!edges[j].has(i)) edges[j].set(i, [c, KIND_KNN]);
      }
    }
  }
  // hub: guarantee the rest frame stays reachable
  for (let i = 0; i < n; i++) {
    if (i === restFrame || edges[i].has(restFrame)) continue;
    let reach = false;
    for (const j of edges[i].keys()) {
      if (edges[j].has(restFrame)) {
        reach = true;
        break;
      }
    }
    if (!reach) {
      const c = C[i * n + restFrame];
      edges[i].set(restFrame, [c < costClip ? c : costClip, KIND_HUB]);
    }
  }

  const offsets: number[] = [0];
  const to: number[] = [];
  const cost: number[] = [];
  const kind: number[] = [];
  for (let i = 0; i < n; i++) {
    const keys = Array.from(edges[i].keys()).sort((x, y) => x - y);
    for (const j of keys) {
      const [c, kd] = edges[i].get(j)!;
      to.push(j);
      cost.push(pyRound(c, 2));
      kind.push(kd);
    }
    offsets.push(to.length);
  }

  const cuts: number[] = [];
  for (let i = 0; i < n; i++) if (cutAfter[i]) cuts.push(i);

  const out: MotionGraph = {
    schema: 'ania.motion_graph',
    version: 1,
    frameCount: n,
    metric: {
      gray: GRAY,
      alpha: ALPHA,
      edge: EDGE,
      wGray: W_GRAY,
      wAlpha: W_ALPHA,
      wEdge: W_EDGE,
      window: windowN,
    },
    succCostMedian: succMedian,
    costClip,
    k,
    edgeCostMax,
    offsets,
    to,
    cost,
    kind,
    motionEnergy: Array.from(motionEnergy, (v) => pyRound(v, 3)),
    restFrame,
    cuts,
  };
  if (opts.contentHash) out.contentHash = opts.contentHash;
  return out;
}

/**
 * Frames -> `motion_graph.json`. The whole offline graph step, in the browser.
 *
 * @param frames RGBA pixel buffers (`ImageData` works directly).
 * @param opts   see {@link MotionGraphOptions}.
 */
export function buildMotionGraph(frames: FramePixels[], opts: MotionGraphOptions = {}): MotionGraph {
  const n = frames.length;
  const every = opts.progressEvery ?? 50;
  const sigs: Float32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    sigs[i] = signature(frames[i]);
    if (opts.onProgress && (i + 1) % every === 0) opts.onProgress(i + 1, n);
  }
  const seq = opts.frameSeq ?? new Int32Array(n);
  const V = allPairsSq(sigs);
  return buildGraphFromDistances(V, n, seq, opts);
}
