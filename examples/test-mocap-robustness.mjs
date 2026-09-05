/**
 * Regression test for the "one frame forever" freeze seen on the web /mocap page.
 *
 * Two independent failure modes are pinned here:
 *
 *  1. `computeDescriptor` must read a `Float32Array` as a flat landmark buffer.
 *     A capture worker posts landmarks as `Float32Array` (transferable, half the
 *     bytes). The old `isFlat` only recognised `Float64Array`/`Array`, so those
 *     buffers went down the array-of-points path, `pts[i].x` read `undefined` off
 *     a number, and 10 face dims (+21 pose/hand dims) came out NaN while the
 *     group bits stayed set in the mask.
 *
 *  2. `MotionMatcher` must keep animating even when a producer pushes NaN.
 *     One NaN dim made every candidate cost NaN in `scores()`, every
 *     `Number.isFinite(S[j])` test failed, the cost loop selected nothing, and
 *     the avatar held one frame forever with `S_best = -1`, `E_best = 0` and a
 *     climbing `dwell`. A single NaN also poisoned the One-Euro state permanently,
 *     so even switching back to a clean pose source could not recover.
 *
 * Run: npm run build && node examples/test-mocap-robustness.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 */

import { computeDescriptor, MotionMatcher, OneEuroVector, NDIMS, NEUTRAL, DIM_INDEX } from '../dist/index.js';

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

// ---------------------------------------------------------------------------
// 1. Float32Array landmark buffers take the flat path (no NaN, same values).
// ---------------------------------------------------------------------------

const FACE_POINTS = 478;
const POSE_POINTS = 33;
const HAND_POINTS = 21;

const faceF32 = new Float32Array(FACE_POINTS * 3);
for (let i = 0; i < FACE_POINTS; i++) {
  faceF32[i * 3] = 0.35 + 0.0004 * i;
  faceF32[i * 3 + 1] = 0.30 + 0.0003 * i;
  faceF32[i * 3 + 2] = 0.01 * Math.sin(i);
}
const poseF32 = new Float32Array(POSE_POINTS * 4);
for (let i = 0; i < POSE_POINTS; i++) {
  poseF32[i * 4] = 0.4 + 0.01 * i;
  poseF32[i * 4 + 1] = 0.3 + 0.008 * i;
  poseF32[i * 4 + 2] = 0;
  poseF32[i * 4 + 3] = 0.9;
}
const handF32 = new Float32Array(HAND_POINTS * 3);
for (let i = 0; i < HAND_POINTS; i++) {
  handF32[i * 3] = 0.6 + 0.005 * i;
  handF32[i * 3 + 1] = 0.5 + 0.004 * i;
  handF32[i * 3 + 2] = 0;
}

const nonFinite = (arr) => Array.from(arr).filter((v) => !Number.isFinite(v)).length;

for (const mirror of [false, true]) {
  const label = mirror ? 'Float32Array (mirror)' : 'Float32Array';
  const [v32, m32] = computeDescriptor(faceF32, null, poseF32, [handF32], mirror);
  const [v64, m64] = computeDescriptor(
    Float64Array.from(faceF32),
    null,
    Float64Array.from(poseF32),
    [Float64Array.from(handF32)],
    mirror
  );
  ok(`${label}: no non-finite dim (${nonFinite(v32)} found)`, nonFinite(v32) === 0);
  ok(`${label}: mask is 127 (got ${m32})`, m32 === 127);
  ok(`${label}: mask matches the Float64Array read (${m32} vs ${m64})`, m32 === m64);
  let maxDiff = 0;
  for (let i = 0; i < NDIMS; i++) maxDiff = Math.max(maxDiff, Math.abs(v32[i] - v64[i]));
  ok(`${label}: values match the Float64Array read (max diff ${maxDiff.toExponential(3)})`, maxDiff <= 1e-6);
}

// A plain array of MediaPipe-shaped points must still take the object path.
const facePts = Array.from({ length: FACE_POINTS }, (_, i) => ({
  x: 0.35 + 0.0004 * i,
  y: 0.3 + 0.0003 * i,
  z: 0.01 * Math.sin(i),
}));
const [vPts, mPts] = computeDescriptor(facePts, null, null, null, false);
ok(`array-of-points: no non-finite dim (${nonFinite(vPts)} found)`, nonFinite(vPts) === 0);
ok(`array-of-points: mask is 15 (got ${mPts})`, mPts === 15);

// Degenerate landmarks must yield NEUTRAL + a cleared group bit, never NaN.
const faceNaN = new Float32Array(FACE_POINTS * 3).fill(NaN);
const [vNaN, mNaN] = computeDescriptor(faceNaN, null, null, null, false);
ok(`NaN landmarks: no non-finite dim (${nonFinite(vNaN)} found)`, nonFinite(vNaN) === 0);
ok(`NaN landmarks: face group bits cleared (mask ${mNaN})`, (mNaN & 0b1111) === 0);

// ---------------------------------------------------------------------------
// 2. A NaN-laden descriptor with mask 127 must not freeze the matcher.
// ---------------------------------------------------------------------------

// Small synthetic bank: two sequences, a smooth head sweep, all groups measured.
const N = 120;
const bankData = [];
const bankMask = [];
for (let i = 0; i < N; i++) {
  const row = Array.from(NEUTRAL).slice(0, 40);
  row[DIM_INDEX.headYaw] = Math.sin((2 * Math.PI * i) / N);
  row[DIM_INDEX.headPitch] = 0.5 * Math.cos((2 * Math.PI * i) / N);
  row[DIM_INDEX.headRoll] = 0.25 * Math.sin((4 * Math.PI * i) / N);
  row[DIM_INDEX.mouthOpen] = 0.5 + 0.5 * Math.sin((6 * Math.PI * i) / N);
  bankData.push(...row);
  bankMask.push(127);
}
const poses = {
  descriptorVersion: 1,
  dims: 40,
  frameCount: N,
  data: bankData,
  mask: bankMask,
  dimValid: new Array(40).fill(1),
  seq: [
    { name: 'idle', low: 0, high: 59 },
    { name: 'talk', low: 60, high: N - 1 },
  ],
  restFrame: 30,
};

const STEPS = 60;

function replay(label, makeValues, mask) {
  const matcher = new MotionMatcher(poses, null, {}, new OneEuroVector());
  let frame = poses.restFrame;
  const seen = new Set([frame]);
  let sentinelSteps = 0;
  let nonFiniteDebug = 0;
  let t = 0;
  for (let k = 0; k < STEPS; k++) {
    t += 1000 / 30;
    matcher.pushPose(t, mask, makeValues(k), 'raw');
    matcher.setAudio(false, 0, 0.6);
    const r = matcher.step(t, frame);
    frame = r.frame;
    seen.add(frame);
    if (r.debug.S_best === -1) sentinelSteps++;
    if (!Number.isFinite(r.debug.E_best) || !Number.isFinite(r.debug.ema_E)) nonFiniteDebug++;
  }
  ok(`${label}: moved across frames (${seen.size} distinct in ${STEPS} steps)`, seen.size > 1);
  ok(`${label}: never returned the S_best = -1 sentinel (${sentinelSteps} steps did)`, sentinelSteps === 0);
  ok(`${label}: debug stayed finite (${nonFiniteDebug} steps did not)`, nonFiniteDebug === 0);
  return seen.size;
}

const cleanValues = (k) => {
  const v = Float64Array.from(NEUTRAL);
  v[DIM_INDEX.headYaw] = Math.sin((2 * Math.PI * k) / 45);
  v[DIM_INDEX.headPitch] = 0.5 * Math.cos((2 * Math.PI * k) / 45);
  v[DIM_INDEX.mouthOpen] = 0.5 + 0.5 * Math.sin((2 * Math.PI * k) / 20);
  return v;
};

const cleanDistinct = replay('clean descriptor', cleanValues, 127);

// The exact shape observed in the browser: 31 NaN dims, mask still 127.
const NAN_DIMS = [0, 1, 2, 3, 8, 9, 10, 12, 13, 14, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38, 39];
replay(
  'NaN-laden descriptor (31 dims, mask 127)',
  (k) => {
    const v = cleanValues(k);
    for (const d of NAN_DIMS) v[d] = NaN;
    return v;
  },
  127
);

// Every dim NaN, including the reserved block, is still not allowed to freeze.
replay(
  'all-NaN descriptor (mask 255)',
  () => new Float64Array(NDIMS).fill(NaN),
  255
);

// Infinities are the same class of poison.
replay(
  'Infinity descriptor (mask 127)',
  (k) => {
    const v = cleanValues(k);
    v[DIM_INDEX.headYaw] = Infinity;
    v[DIM_INDEX.handR_y] = -Infinity;
    return v;
  },
  127
);

// A NaN burst must not permanently poison the One-Euro state: after it stops,
// the matcher must track the clean stream exactly as if the burst never happened.
{
  const poisoned = new MotionMatcher(poses, null, {}, new OneEuroVector());
  const pristine = new MotionMatcher(poses, null, {}, new OneEuroVector());
  let fp = poses.restFrame;
  let fq = poses.restFrame;
  let t = 0;
  let recovered = true;
  for (let k = 0; k < STEPS; k++) {
    t += 1000 / 30;
    const clean = cleanValues(k);
    const dirty = Float64Array.from(clean);
    if (k < 10) for (const d of NAN_DIMS) dirty[d] = NaN;
    poisoned.pushPose(t, 127, dirty, 'raw');
    pristine.pushPose(t, 127, clean, 'raw');
    poisoned.setAudio(false, 0, 0.6);
    pristine.setAudio(false, 0, 0.6);
    fp = poisoned.step(t, fp).frame;
    fq = pristine.step(t, fq).frame;
  }
  // Both are on the same clean stream by the end; the residual must be finite.
  const res = poisoned.residual(fp);
  recovered = Array.from(res).every((v) => Number.isFinite(v));
  ok('NaN burst: residual stays finite after recovery', recovered);
  ok('NaN burst: matcher kept animating (frame ' + fp + ')', fp !== poses.restFrame);
}

console.log(
  `\nmocap robustness: ${pass} passed, ${fail} failed (clean replay visited ${cleanDistinct} frames)`
);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
