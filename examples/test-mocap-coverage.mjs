/**
 * Parity test for the poses.json / coverage.json builders
 * (motion-matcher/coverage-builder.ts) against the fixture generated from the
 * Python reference (`AniaAPP/src/ania_player/plugins/mocap_webcam/index.py`,
 * exported by `AniaAPP/tools/mocap_lab/export_fixtures.py`).
 *
 * Run: npm run build && node examples/test-mocap-coverage.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 *
 * WHAT IS CHECKED, per case
 *   1. `buildPosesIndex(rows, masks, seq, opts)` against the expected poses.json:
 *      data / mask / confidence / frameSeq / cuts / dimValid / seq / restFrame /
 *      ranges.p05 / ranges.p95 / neutral. This is where numpy's `linear`
 *      percentile, numpy's median and Python's round-half-to-even all have to
 *      agree; nothing here is a "close enough" comparison of derived values.
 *   2. `buildCoverage(expectedPoses)` against the expected coverage.json: every
 *      bin's edges and counts, the 7x5 yaw/pitch histogram, the hand-visibility
 *      quadrants, the gap list (dim/bin/label/need/have/preset, in order),
 *      indexedFrames, meanConfidence, coverageScore, calibrationPresets.
 *
 * TOLERANCE NOTE: integers and counts are compared exactly; the float arrays
 * within 1e-6. Every float the builders emit is already `round(x, 3)` on the
 * Python side and `pyRound(x, 3)` here, so in practice these match exactly —
 * 1e-6 is the fixture's own precision floor, not a loosened check.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPosesIndex, buildCoverage } from '../dist/index.js';

const FIXTURES_DIR =
  process.env.ANIA_MOCAP_FIXTURES ||
  'E:/backup_2026/Repositórios/AnimatedAvatar/AniaAPP/tests/fixtures/mocap';

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'coverage_cases.json'), 'utf8'));

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

let worstFloat = 0;

const intArray = (label, got, want) => {
  let same = got.length === want.length;
  let firstBad = -1;
  if (same) {
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) {
        same = false;
        firstBad = i;
        break;
      }
    }
  }
  ok(`${label} exact (${want.length} entries${firstBad >= 0 ? `, first diff at ${firstBad}: ${got[firstBad]} vs ${want[firstBad]}` : ''})`, same);
};

const floatArray = (label, got, want) => {
  let worst = 0;
  let at = -1;
  const lenOk = got.length === want.length;
  if (lenOk) {
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(got[i] - want[i]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
  }
  if (worst > worstFloat) worstFloat = worst;
  ok(`${label} within 1e-6 (${want.length} entries, worst ${worst.toExponential(3)} at ${at})`, lenOk && worst <= 1e-6);
};

for (const c of fixture.cases) {
  const inp = c.input;
  const wantPoses = c.expectedPoses;
  const wantCov = c.expectedCoverage;

  // ---- 1. poses.json
  const poses = buildPosesIndex(inp.rows, inp.masks, inp.seq, {
    confidence: inp.confidence,
    contentHash: inp.contentHash,
    generator: inp.generator,
    source: inp.source,
    cuts: inp.cuts,
    motionEnergy: inp.motionEnergy,
    dims: inp.dims,
  });

  ok(`${c.name}: poses schema/descriptorVersion/dims/frameCount/source/contentHash`,
    poses.schema === wantPoses.schema &&
      poses.descriptorVersion === wantPoses.descriptorVersion &&
      poses.dims === wantPoses.dims &&
      poses.frameCount === wantPoses.frameCount &&
      poses.source === wantPoses.source &&
      poses.contentHash === wantPoses.contentHash);
  ok(`${c.name}: poses.restFrame ${poses.restFrame} === ${wantPoses.restFrame}`, poses.restFrame === wantPoses.restFrame);
  intArray(`${c.name}: poses.mask`, poses.mask, wantPoses.mask);
  intArray(`${c.name}: poses.frameSeq`, poses.frameSeq, wantPoses.frameSeq);
  intArray(`${c.name}: poses.cuts`, poses.cuts, wantPoses.cuts);
  intArray(`${c.name}: poses.dimValid`, poses.dimValid, wantPoses.dimValid);
  floatArray(`${c.name}: poses.data`, poses.data, wantPoses.data);
  floatArray(`${c.name}: poses.confidence`, poses.confidence, wantPoses.confidence);
  floatArray(`${c.name}: poses.ranges.p05`, poses.ranges.p05, wantPoses.ranges.p05);
  floatArray(`${c.name}: poses.ranges.p95`, poses.ranges.p95, wantPoses.ranges.p95);
  floatArray(`${c.name}: poses.neutral`, poses.neutral, wantPoses.neutral);
  ok(`${c.name}: poses.seq matches (${wantPoses.seq.length} sequences)`,
    poses.seq.length === wantPoses.seq.length &&
      poses.seq.every((s, i) => s.name === wantPoses.seq[i].name && s.low === wantPoses.seq[i].low && s.high === wantPoses.seq[i].high));

  // ---- 2. coverage.json (built from the expected poses, so a poses regression
  //         cannot mask a coverage regression)
  const cov = buildCoverage(wantPoses);

  ok(`${c.name}: coverage schema/version/descriptorVersion/frameCount/source/contentHash`,
    cov.schema === wantCov.schema &&
      cov.version === wantCov.version &&
      cov.descriptorVersion === wantCov.descriptorVersion &&
      cov.frameCount === wantCov.frameCount &&
      cov.source === wantCov.source &&
      cov.contentHash === wantCov.contentHash);
  ok(`${c.name}: coverage.indexedFrames ${cov.indexedFrames} === ${wantCov.indexedFrames}`,
    cov.indexedFrames === wantCov.indexedFrames);
  ok(`${c.name}: coverage.meanConfidence ${cov.meanConfidence} === ${wantCov.meanConfidence}`,
    Math.abs(cov.meanConfidence - wantCov.meanConfidence) <= 1e-6);
  ok(`${c.name}: coverage.coverageScore ${cov.coverageScore} === ${wantCov.coverageScore}`,
    Math.abs(cov.coverageScore - wantCov.coverageScore) <= 1e-6);

  const gotDims = Object.keys(cov.bins);
  const wantDims = Object.keys(wantCov.bins);
  ok(`${c.name}: coverage.bins dims [${gotDims}] === [${wantDims}]`,
    gotDims.length === wantDims.length && gotDims.every((k, i) => k === wantDims[i]));
  for (const dim of wantDims) {
    floatArray(`${c.name}: bins.${dim}.edges`, cov.bins[dim].edges, wantCov.bins[dim].edges);
    intArray(`${c.name}: bins.${dim}.counts`, cov.bins[dim].counts, wantCov.bins[dim].counts);
  }
  intArray(`${c.name}: headYawPitch.counts`, cov.headYawPitch.counts, wantCov.headYawPitch.counts);
  floatArray(`${c.name}: headYawPitch.yawEdges`, cov.headYawPitch.yawEdges, wantCov.headYawPitch.yawEdges);
  floatArray(`${c.name}: headYawPitch.pitchEdges`, cov.headYawPitch.pitchEdges, wantCov.headYawPitch.pitchEdges);
  ok(`${c.name}: hands ${JSON.stringify(cov.hands)} === ${JSON.stringify(wantCov.hands)}`,
    cov.hands.noneVisible === wantCov.hands.noneVisible &&
      cov.hands.leftOnly === wantCov.hands.leftOnly &&
      cov.hands.rightOnly === wantCov.hands.rightOnly &&
      cov.hands.both === wantCov.hands.both);
  ok(`${c.name}: gaps (${cov.gaps.length} vs ${wantCov.gaps.length}) match in order`,
    cov.gaps.length === wantCov.gaps.length &&
      cov.gaps.every((g, i) => {
        const e = wantCov.gaps[i];
        return g.dim === e.dim && g.bin === e.bin && g.label === e.label && g.need === e.need &&
          g.have === e.have && g.preset === e.preset;
      }));
  ok(`${c.name}: calibrationPresets`,
    cov.calibrationPresets.length === wantCov.calibrationPresets.length &&
      cov.calibrationPresets.every((p, i) => p === wantCov.calibrationPresets[i]));
}

const totalFrames = fixture.cases.reduce((a, c) => a + c.expectedPoses.frameCount, 0);
const totalGaps = fixture.cases.reduce((a, c) => a + c.expectedCoverage.gaps.length, 0);
console.log(
  `\nmocap coverage: ${pass} passed, ${fail} failed ` +
    `(${fixture.cases.length} cases / ${totalFrames} frames / ${totalGaps} gaps, worst float ${worstFloat.toExponential(2)})`
);
if (failures.length) {
  console.log('\n' + failures.slice(0, 40).join('\n'));
  if (failures.length > 40) console.log(`... and ${failures.length - 40} more`);
  process.exit(1);
}
