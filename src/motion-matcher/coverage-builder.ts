// ===========================================================================
// poses.json / coverage.json builders — the browser-side port of
// `AniaAPP/src/ania_player/plugins/mocap_webcam/index.py`.
//
// PURE: plain arithmetic over plain arrays, so this runs in a Web Worker next
// to `buildMotionGraph` and the whole Ania 2.0 index can be produced client-side
// instead of asking the user to load an "índice local" file.
//
// PARITY: bit-exact against the Python reference, including numpy's `linear`
// percentile interpolation (with its `_lerp` two-branch form), numpy's median
// (mean of the two middle values on an even count), numpy's `histogram`
// half-open bins with an inclusive last edge, and Python's round-half-to-even
// `round(x, n)` on every emitted number (see `pyRound` in graph-builder.ts).
// ===========================================================================

import { DESCRIPTOR_VERSION, DIM_INDEX, NDIMS, NUSED, groupVector } from './descriptor';
import { pyRound } from './graph-builder';
import type { PosesBank } from './matcher';

export const SCHEMA_POSES = 'ania.poses';
export const SCHEMA_COVERAGE = 'ania.coverage';

/** `dimValid` when the caller does not supply one: the 40 used dims. */
export const DIM_VALID_DEFAULT: number[] = Array.from({ length: NDIMS }, (_, i) => (i < NUSED ? 1 : 0));

/** Marginal target bins (dim -> edges, weight). "count >= 3" per bin = covered. */
export const TARGET_BINS: [string, number[], number][] = [
  ['headYaw', [-1, -0.6, -0.3, -0.1, 0.1, 0.3, 0.6, 1], 1.0],
  ['headPitch', [-1, -0.5, -0.15, 0.15, 0.5, 1], 1.0],
  ['mouthOpen', [0, 0.15, 0.5, 1], 0.7],
  ['browRaise', [-1, -0.3, 0.3, 1], 0.5],
  ['mouthSmile', [0, 0.3, 1], 0.5],
  ['eyeBlinkL', [0, 0.5, 1], 0.3],
  ['handL_vis', [0, 0.5, 1], 1.0],
  ['handR_vis', [0, 0.5, 1], 1.0],
  ['handL_y', [-1, -0.2, 0.3, 1], 1.0],
  ['handR_y', [-1, -0.2, 0.3, 1], 1.0],
];

export const GAP_PRESET: Record<string, string> = {
  headYaw: 'head_turn',
  headPitch: 'head_nod',
  browRaise: 'brows_surprise',
  mouthSmile: 'smile',
  mouthOpen: 'talk',
  eyeBlinkL: 'blink',
  handL_vis: 'hands_wave',
  handR_vis: 'hands_wave',
  handL_y: 'hands_raise',
  handR_y: 'hands_raise',
};

export const PRESETS = ['head_turn', 'head_nod', 'brows_surprise', 'smile', 'hands_wave', 'hands_raise'];

export interface Sequence {
  name: string;
  low: number;
  high: number;
}

export interface CoverageGap {
  dim: string;
  bin: number;
  label: string;
  need: number;
  have: number;
  preset: string;
}

export interface Coverage {
  schema: string;
  version: number;
  contentHash: string;
  descriptorVersion: number;
  frameCount: number;
  indexedFrames: number;
  meanConfidence: number;
  source: string;
  bins: Record<string, { edges: number[]; counts: number[] }>;
  headYawPitch: { yawEdges: number[]; pitchEdges: number[]; counts: number[] };
  hands: { noneVisible: number; leftOnly: number; rightOnly: number; both: number };
  gaps: CoverageGap[];
  coverageScore: number;
  calibrationPresets: string[];
}

// ----------------------------------------------------------------- numpy bits
/** numpy `np.percentile(..., method='linear')`, including its `_lerp` branches. */
function percentileSorted(sorted: Float64Array | number[], q: number): number {
  const m = sorted.length;
  if (m === 0) return NaN;
  if (m === 1) return sorted[0];
  const virtual = (q / 100) * (m - 1);
  let lo = Math.floor(virtual);
  if (lo < 0) lo = 0;
  if (lo > m - 1) lo = m - 1;
  let hi = lo + 1;
  if (hi > m - 1) hi = m - 1;
  const t = virtual - lo;
  const a = sorted[lo];
  const b = sorted[hi];
  const diff = b - a;
  return t < 0.5 ? a + diff * t : b - diff * (1 - t);
}

/** numpy `np.median`: middle value, or the mean of the two middle values. */
function medianSorted(sorted: Float64Array | number[]): number {
  const m = sorted.length;
  if (m === 0) return NaN;
  const h = m >> 1;
  return m % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
}

function sortedColumn(rows: ArrayLike<number>, stride: number, idx: number[], col: number): Float64Array {
  const out = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = rows[idx[i] * stride + col];
  out.sort();
  return out;
}

/**
 * numpy `np.histogram(a, bins=edges)`: bins are half-open `[e_i, e_{i+1})`, the
 * last one closed `[e_{n-1}, e_n]`, and samples outside `[e_0, e_n]` are dropped.
 */
function histogram(vals: number[], edges: number[]): number[] {
  const nb = edges.length - 1;
  const counts = new Array<number>(nb).fill(0);
  const lo = edges[0];
  const hi = edges[nb];
  for (const v of vals) {
    if (!(v >= lo) || !(v <= hi)) continue;
    let b = 0;
    while (b < nb - 1 && v >= edges[b + 1]) b++;
    counts[b]++;
  }
  return counts;
}

function binOf(v: number, edges: number[]): number {
  const nb = edges.length - 1;
  if (!(v >= edges[0]) || !(v <= edges[nb])) return -1;
  let b = 0;
  while (b < nb - 1 && v >= edges[b + 1]) b++;
  return b;
}

// -------------------------------------------------------------------- seq/fs
/**
 * Build the `seq` list: idle/talk ranges, actions, then contiguous leftovers as
 * orphans. Mirrors `index.sequences_from_ranges`.
 */
export function sequencesFromRanges(
  frameCount: number,
  idle: [number, number],
  talk: [number, number],
  actions: [string, number, number][] = [],
): Sequence[] {
  const ranges: [number, number, string][] = [];
  if (idle[1] >= idle[0] && idle[1] >= 0) {
    ranges.push([Math.max(0, idle[0]), Math.min(frameCount - 1, idle[1]), 'idle']);
  }
  if (talk[1] >= talk[0] && talk[1] >= 0) {
    ranges.push([Math.max(0, talk[0]), Math.min(frameCount - 1, talk[1]), 'talk']);
  }
  for (const [name, lo, hi] of actions) {
    if (hi >= lo) ranges.push([Math.max(0, lo), Math.min(frameCount - 1, hi), `action:${name}`]);
  }
  const covered = new Uint8Array(frameCount);
  const out: Sequence[] = [];
  for (const [lo, hi, name] of ranges) {
    out.push({ name, low: lo, high: hi });
    for (let i = lo; i <= hi; i++) covered[i] = 1;
  }
  let k = 0;
  let i = 0;
  while (i < frameCount) {
    if (covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < frameCount && !covered[j + 1]) j++;
    k++;
    out.push({ name: `orphan:${k}`, low: i, high: j });
    i = j + 1;
  }
  return out;
}

/** Per-frame sequence index. Mirrors `index.frame_seq`. */
export function frameSeq(frameCount: number, seqs: Sequence[]): Int32Array {
  const fs = new Int32Array(frameCount).fill(-1);
  for (let si = 0; si < seqs.length; si++) {
    const lo = seqs[si].low | 0;
    const hi = seqs[si].high | 0;
    for (let i = Math.max(0, lo); i <= Math.min(frameCount - 1, hi); i++) {
      if (fs[i] === -1) fs[i] = si;
    }
  }
  for (let i = 0; i < frameCount; i++) if (fs[i] === -1) fs[i] = 0;
  return fs;
}

// ----------------------------------------------------------------- buildPoses
export interface PosesIndexOptions {
  /** Per-frame confidence. Default: 1.0 for every frame. */
  confidence?: ArrayLike<number>;
  contentHash?: string;
  generator?: Record<string, unknown>;
  source?: string;
  /** Per-dim validity flags. Default {@link DIM_VALID_DEFAULT}. */
  dimValid?: ArrayLike<number>;
  cuts?: ArrayLike<number>;
  motionEnergy?: ArrayLike<number>;
  /** Emitted dimension count. Default 40 (`NUSED`). */
  dims?: number;
}

/**
 * Descriptors + masks + sequences -> the `poses.json` object.
 * Mirrors `index.build_poses`.
 */
export function buildPosesIndex(
  descriptors: ArrayLike<number>[],
  masks: ArrayLike<number>,
  seq: Sequence[],
  opts: PosesIndexOptions = {},
): PosesBank {
  const n = descriptors.length;
  const dims = opts.dims ?? NUSED;
  const R = new Float64Array(n * NDIMS);
  for (let i = 0; i < n; i++) {
    const row = descriptors[i];
    const lim = Math.min(row.length, NDIMS);
    for (let j = 0; j < lim; j++) R[i * NDIMS + j] = row[j];
  }
  const M = new Int32Array(n);
  for (let i = 0; i < n; i++) M[i] = Number(masks[i]) | 0;
  const C = new Float64Array(n);
  for (let i = 0; i < n; i++) C[i] = opts.confidence ? Number(opts.confidence[i]) : 1.0;
  const fs = frameSeq(n, seq);
  const dvSrc = opts.dimValid ?? DIM_VALID_DEFAULT;
  const dv = new Float64Array(NDIMS);
  for (let i = 0; i < NDIMS; i++) dv[i] = i < dvSrc.length ? Number(dvSrc[i]) : 0;

  let good = new Uint8Array(n);
  let anyGood = false;
  for (let i = 0; i < n; i++) {
    good[i] = C[i] >= 0.6 ? 1 : 0;
    if (good[i]) anyGood = true;
  }
  if (!anyGood) {
    good = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      good[i] = M[i] !== 0 ? 1 : 0;
      if (good[i]) anyGood = true;
    }
  }
  if (!anyGood) good = new Uint8Array(n).fill(1);

  const goodIdx: number[] = [];
  for (let i = 0; i < n; i++) if (good[i]) goodIdx.push(i);

  const p05 = new Float64Array(NDIMS);
  const p95 = new Float64Array(NDIMS);
  for (let c = 0; c < NDIMS; c++) {
    const col = sortedColumn(R, NDIMS, goodIdx, c);
    p05[c] = percentileSorted(col, 5);
    p95[c] = percentileSorted(col, 95);
  }
  for (let c = 0; c < NDIMS; c++) {
    if (p95[c] - p05[c] < 1e-3) {
      p05[c] -= 0.05;
      p95[c] += 0.05;
    }
  }

  const idleFrames: number[] = [];
  for (let i = 0; i < n; i++) {
    const nm = String(seq[fs[i]]?.name ?? '');
    if (nm.startsWith('idle') && good[i]) idleFrames.push(i);
  }
  const neutralPool = idleFrames.length ? idleFrames : goodIdx;
  const neutral = new Float64Array(NDIMS);
  for (let c = 0; c < NDIMS; c++) neutral[c] = medianSorted(sortedColumn(R, NDIMS, neutralPool, c));

  const me = new Float64Array(n);
  if (opts.motionEnergy) for (let i = 0; i < n; i++) me[i] = Number(opts.motionEnergy[i]) || 0;

  const pool = idleFrames.length ? idleFrames : Array.from({ length: n }, (_, i) => i);
  let best = 0;
  let bestKey: [number, number, number] | null = null;
  for (const i of pool) {
    let acc = 0;
    for (let c = 0; c < dims; c++) {
      const d = R[i * NDIMS + c] - neutral[c];
      acc += d * d;
    }
    const e = Math.sqrt(acc / dims);
    const key: [number, number, number] = [pyRound(e, 4), pyRound(me[i], 4), i];
    if (
      bestKey === null ||
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
    ) {
      bestKey = key;
      best = i;
    }
  }

  const data: number[] = new Array(n * dims);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < dims; c++) data[i * dims + c] = pyRound(R[i * NDIMS + c], 3);
  }

  return {
    schema: SCHEMA_POSES,
    descriptorVersion: DESCRIPTOR_VERSION,
    dims,
    contentHash: opts.contentHash ?? '',
    frameCount: n,
    generator: opts.generator ?? { tool: 'ania-mocap-lab', version: '0.1.0' },
    source: opts.source ?? 'mediapipe',
    dimValid: Array.from(dv.subarray(0, dims), (v) => Math.trunc(v)),
    data,
    mask: Array.from(M, (v) => v),
    confidence: Array.from(C, (v) => pyRound(v, 3)),
    seq: seq.map((s) => ({ ...s })),
    frameSeq: Array.from(fs, (v) => v),
    cuts: opts.cuts ? Array.from(opts.cuts, (v) => Number(v) | 0) : [],
    ranges: {
      p05: Array.from(p05.subarray(0, dims), (v) => pyRound(v, 3)),
      p95: Array.from(p95.subarray(0, dims), (v) => pyRound(v, 3)),
    },
    neutral: Array.from(neutral.subarray(0, dims), (v) => pyRound(v, 3)),
    restFrame: best,
  } as PosesBank;
}

// -------------------------------------------------------------- buildCoverage
/**
 * `poses.json` -> `coverage.json`: which marginal bins the bank actually covers,
 * which gaps need a calibration preset, and the overall coverage score.
 * Mirrors `index.build_coverage`.
 */
export function buildCoverage(poses: PosesBank, minCount = 3): Coverage {
  const n = Number(poses.frameCount) | 0;
  const d = Number(poses.dims ?? NUSED) | 0;
  const data = poses.data;
  const conf = new Float64Array(n);
  const confSrc = poses.confidence as ArrayLike<number> | undefined;
  for (let i = 0; i < n; i++) conf[i] = confSrc ? Number(confSrc[i]) : 1.0;
  const masks = new Int32Array(n);
  const maskSrc = poses.mask;
  for (let i = 0; i < n; i++) masks[i] = maskSrc ? Number(maskSrc[i]) | 0 : 0xff;

  const good = new Uint8Array(n);
  for (let i = 0; i < n; i++) good[i] = conf[i] >= 0.6 ? 1 : 0;

  // groupVector is pure and only depends on the mask value — memoise per value
  const gvCache = new Map<number, Float64Array>();
  const gv = (m: number): Float64Array => {
    let v = gvCache.get(m);
    if (!v) {
      v = groupVector(m);
      gvCache.set(m, v);
    }
    return v;
  };

  const bins: Record<string, { edges: number[]; counts: number[] }> = {};
  const gaps: CoverageGap[] = [];
  let scoreNum = 0.0;
  let scoreDen = 0.0;

  for (const [name, edges, w] of TARGET_BINS) {
    const di = DIM_INDEX[name];
    if (di >= d) continue;
    const isHandY = name.startsWith('hand') && name.endsWith('_y');
    const visI = isHandY ? DIM_INDEX[name.replace('_y', '_vis')] : -1;
    const vals: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!good[i]) continue;
      if (!(gv(masks[i])[di] > 0.5)) continue;
      if (isHandY && !(Number(data[i * d + visI]) >= 0.5)) continue;
      vals.push(Number(data[i * d + di]));
    }
    const counts = histogram(vals, edges);
    bins[name] = { edges: edges.slice(), counts };
    for (let b = 0; b < counts.length; b++) {
      scoreDen += w;
      if (counts[b] >= minCount) {
        scoreNum += w;
      } else {
        gaps.push({
          dim: name,
          bin: b,
          label: `coverage.gap.${name}.${b}`,
          need: minCount,
          have: counts[b],
          preset: GAP_PRESET[name] ?? 'head_turn',
        });
      }
    }
  }

  const yawE = [-1, -0.6, -0.3, -0.1, 0.1, 0.3, 0.6, 1];
  const pitchE = [-1, -0.5, -0.15, 0.15, 0.5, 1];
  const yawN = yawE.length - 1;
  const pitchN = pitchE.length - 1;
  const hist2 = new Array<number>(yawN * pitchN).fill(0);
  for (let i = 0; i < n; i++) {
    if (!good[i]) continue;
    if (!(gv(masks[i])[0] > 0.5)) continue;
    const by = binOf(Number(data[i * d + 0]), yawE);
    const bp = binOf(Number(data[i * d + 1]), pitchE);
    if (by < 0 || bp < 0) continue;
    hist2[by * pitchN + bp]++;
  }

  const lvI = DIM_INDEX['handL_vis'];
  const rvI = DIM_INDEX['handR_vis'];
  let noneVisible = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  let both = 0;
  for (let i = 0; i < n; i++) {
    const lv = Number(data[i * d + lvI]) >= 0.5;
    const rv = Number(data[i * d + rvI]) >= 0.5;
    if (lv && rv) both++;
    else if (lv) leftOnly++;
    else if (rv) rightOnly++;
    else noneVisible++;
  }

  let indexed = 0;
  for (let i = 0; i < n; i++) if (masks[i] !== 0) indexed++;
  let confSum = 0;
  for (let i = 0; i < n; i++) confSum += conf[i];

  return {
    schema: SCHEMA_COVERAGE,
    version: 1,
    contentHash: String(poses.contentHash ?? ''),
    descriptorVersion: DESCRIPTOR_VERSION,
    frameCount: n,
    indexedFrames: indexed,
    meanConfidence: n ? pyRound(confSum / n, 3) : 0.0,
    source: String(poses.source ?? ''),
    bins,
    headYawPitch: { yawEdges: yawE, pitchEdges: pitchE, counts: hist2 },
    hands: { noneVisible, leftOnly, rightOnly, both },
    gaps,
    coverageScore: scoreDen ? pyRound(scoreNum / scoreDen, 3) : 0.0,
    calibrationPresets: PRESETS.slice(),
  };
}
