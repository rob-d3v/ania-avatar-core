/**
 * Parity test for the motion-graph builder port (motion-matcher/graph-builder.ts)
 * against the fixture generated from the Python reference
 * (`AniaAPP/src/ania_player/plugins/mocap_webcam/graph.py`, exported by
 * `AniaAPP/tools/mocap_lab/export_fixtures.py`).
 *
 * Run: npm run build && node examples/test-mocap-graph.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 *
 * WHAT IS CHECKED
 *   1. `boxResizeRgba` alone, against Pillow's `Image.resize(..., BOX)` on five
 *      source sizes (48x48, 37x53, 96x60, 33x32, 32x32 identity). EXACT — every
 *      one of the 4096 output bytes. Pillow premultiplies alpha before resampling
 *      (RGBA -> RGBa -> resize -> RGBA); a naive per-channel box average is off by
 *      up to 85/255 on frames with a varying alpha channel, so this is the test
 *      that pins the kernel down.
 *   2. Per-frame signature vectors: full 2304-dim vectors for 4 sampled frames of
 *      each bank, plus a sum / sum-of-squares digest for EVERY frame (the whole
 *      set of vectors would be ~2 MB of fixture).
 *   3. The full `motion_graph.json`: offsets / to / kind / cuts / restFrame /
 *      frameCount exactly, cost / motionEnergy / succCostMedian within 1e-6.
 *
 * TOLERANCE NOTE: integer arrays are compared exactly; floats within 1e-6, which
 * is the precision the fixture itself carries (costs are round(c, 2), motion
 * energies round(e, 3), signatures round(v, 6)). The resize kernel is reproduced
 * exactly, so no wider tolerance is needed anywhere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildMotionGraph, boxResizeRgba, signature } from '../dist/index.js';

const FIXTURES_DIR =
  process.env.ANIA_MOCAP_FIXTURES ||
  'E:/backup_2026/Repositórios/AnimatedAvatar/AniaAPP/tests/fixtures/mocap';

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'graph_cases.json'), 'utf8'));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`✗ ${name}`);
  }
};

// --------------------------------------------------------------- PNG decoding
// Minimal decoder for what Pillow writes here: 8-bit RGBA, non-interlaced.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(b64) {
  const buf = Buffer.from(b64, 'base64');
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8ClampedArray(width * height * bpp);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const rowOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[p + x];
      const a = x >= bpp ? out[rowOff + x - bpp] : 0;
      const b = y > 0 ? out[prevOff + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevOff + x - bpp] : 0;
      let v;
      if (ft === 0) v = cur;
      else if (ft === 1) v = cur + a;
      else if (ft === 2) v = cur + b;
      else if (ft === 3) v = cur + ((a + b) >> 1);
      else if (ft === 4) v = cur + paeth(a, b, c);
      else throw new Error(`bad PNG filter ${ft}`);
      out[rowOff + x] = v & 0xff;
    }
    p += stride;
  }
  return { data: out, width, height };
}

// ------------------------------------------------------------- 1. box resize
let resizeExact = 0;
for (const r of fixture.resize) {
  const src = decodePng(r.srcPng);
  const got = boxResizeRgba(src.data, src.width, src.height, 32, 32);
  const want = Buffer.from(r.expectedRgba, 'base64');
  let worst = 0;
  let at = -1;
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs(got[i] - want[i]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst === 0) resizeExact++;
  ok(`resize ${r.width}x${r.height} -> 32x32 byte-exact (worst ${worst} at ${at})`, worst === 0);
}

// ------------------------------------------- 2/3. signatures + motion_graph
const INT_KEYS = ['offsets', 'to', 'kind', 'cuts'];
const FLOAT_KEYS = ['cost', 'motionEnergy'];

let sigWorst = 0;
let digestWorst = 0;
let costWorstAll = 0;

for (const c of fixture.cases) {
  const frames = c.framesPng.map(decodePng);
  ok(`${c.name}: decoded ${frames.length} frames at ${c.width}x${c.height}`,
    frames.length === c.frameCount && frames.every((f) => f.width === c.width && f.height === c.height));

  // --- signatures
  let worstSample = 0;
  for (let s = 0; s < c.signatureSampleFrames.length; s++) {
    const i = c.signatureSampleFrames[s];
    const got = signature(frames[i]);
    const want = c.signatureSample[s];
    for (let d = 0; d < want.length; d++) {
      const diff = Math.abs(got[d] - want[d]);
      if (diff > worstSample) worstSample = diff;
    }
  }
  if (worstSample > sigWorst) sigWorst = worstSample;
  ok(`${c.name}: sampled signature vectors within 1e-6 (worst ${worstSample.toExponential(3)})`, worstSample <= 1e-6);

  let worstDigest = 0;
  for (let i = 0; i < frames.length; i++) {
    const s = signature(frames[i]);
    let sum = 0;
    let sumSq = 0;
    for (let d = 0; d < s.length; d++) {
      sum += s[d];
      sumSq += s[d] * s[d];
    }
    worstDigest = Math.max(worstDigest, Math.abs(sum - c.signatureSum[i]), Math.abs(sumSq - c.signatureSumSq[i]));
  }
  if (worstDigest > digestWorst) digestWorst = worstDigest;
  ok(`${c.name}: per-frame signature digests within 1e-6 (worst ${worstDigest.toExponential(3)})`, worstDigest <= 1e-6);

  // --- graph
  const o = c.options;
  const graph = buildMotionGraph(frames, {
    frameSeq: c.frameSeq,
    k: o.k,
    edgeCostMax: o.edgeCostMax,
    costClip: o.costClip,
    cutThreshold: o.cutThreshold,
    window: o.window,
    restFrame: o.restFrame,
  });
  const want = c.expected;

  ok(`${c.name}: frameCount ${graph.frameCount} === ${want.frameCount}`, graph.frameCount === want.frameCount);
  ok(`${c.name}: restFrame ${graph.restFrame} === ${want.restFrame}`, graph.restFrame === want.restFrame);
  ok(`${c.name}: k/edgeCostMax/costClip echoed`,
    graph.k === want.k && graph.edgeCostMax === want.edgeCostMax && graph.costClip === want.costClip);
  ok(`${c.name}: succCostMedian within 1e-6 (${graph.succCostMedian} vs ${want.succCostMedian})`,
    Math.abs(graph.succCostMedian - want.succCostMedian) <= 1e-6);

  for (const key of INT_KEYS) {
    const g = graph[key];
    const e = want[key];
    let same = g.length === e.length;
    let firstBad = -1;
    if (same) {
      for (let i = 0; i < e.length; i++) {
        if (g[i] !== e[i]) {
          same = false;
          firstBad = i;
          break;
        }
      }
    }
    ok(`${c.name}: ${key} exact (${e.length} entries${firstBad >= 0 ? `, first diff at ${firstBad}: ${g[firstBad]} vs ${e[firstBad]}` : ''})`, same);
  }
  for (const key of FLOAT_KEYS) {
    const g = graph[key];
    const e = want[key];
    let worst = 0;
    let at = -1;
    const lenOk = g.length === e.length;
    if (lenOk) {
      for (let i = 0; i < e.length; i++) {
        const diff = Math.abs(g[i] - e[i]);
        if (diff > worst) {
          worst = diff;
          at = i;
        }
      }
    }
    if (key === 'cost' && worst > costWorstAll) costWorstAll = worst;
    ok(`${c.name}: ${key} within 1e-6 (${e.length} entries, worst ${worst.toExponential(3)} at ${at})`,
      lenOk && worst <= 1e-6);
  }
  ok(`${c.name}: metric block matches`,
    graph.metric.gray === want.metric.gray && graph.metric.alpha === want.metric.alpha &&
    graph.metric.edge === want.metric.edge && graph.metric.window === want.metric.window &&
    graph.metric.wGray === want.metric.wGray && graph.metric.wAlpha === want.metric.wAlpha &&
    graph.metric.wEdge === want.metric.wEdge);
  ok(`${c.name}: schema/version`, graph.schema === want.schema && graph.version === want.version);
}

const totalFrames = fixture.cases.reduce((a, c) => a + c.frameCount, 0);
const totalEdges = fixture.cases.reduce((a, c) => a + c.expected.to.length, 0);
console.log(
  `\nmocap graph: ${pass} passed, ${fail} failed ` +
    `(${fixture.cases.length} banks / ${totalFrames} frames / ${totalEdges} edges, ` +
    `${resizeExact}/${fixture.resize.length} resize cases byte-exact; ` +
    `worst signature ${sigWorst.toExponential(2)}, worst digest ${digestWorst.toExponential(2)}, ` +
    `worst cost ${costWorstAll.toExponential(2)})`
);
if (failures.length) {
  console.log('\n' + failures.slice(0, 40).join('\n'));
  if (failures.length > 40) console.log(`... and ${failures.length - 40} more`);
  process.exit(1);
}
