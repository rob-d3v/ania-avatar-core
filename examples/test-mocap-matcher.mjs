/**
 * Parity test for the MotionMatcher port (motion-matcher/matcher.ts) against
 * the fixture generated from the Python reference
 * (`AniaAPP/src/ania_player/plugins/mocap_webcam/matcher.py`).
 *
 * Replay: start frame = poses.restFrame; for each input, if `push` feed a pose,
 * always sync the audio prior, and if `step` advance the matcher and compare
 * the resulting frame/preload/mode against the fixture — exactly, every tick.
 *
 * Run: npm run build && node examples/test-mocap-matcher.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MotionMatcher, OneEuroVector } from '../dist/index.js';

const FIXTURES_DIR =
  process.env.ANIA_MOCAP_FIXTURES ||
  'E:/backup_2026/Repositórios/AnimatedAvatar/AniaAPP/tests/fixtures/mocap';

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'matcher_case_01.json'), 'utf8'));

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

const matcher = new MotionMatcher(fixture.poses, fixture.graph, fixture.options, new OneEuroVector());

let frame = fixture.poses.restFrame;
let tick = 0;
let framesOk = 0;
let preloadOk = 0;
let modesOk = 0;

for (const inp of fixture.inputs) {
  if (inp.push) matcher.pushPose(inp.t, inp.mask, inp.d, inp.norm ?? 'raw');
  matcher.setAudio(inp.talking, inp.env, 0.6);
  if (inp.step) {
    const r = matcher.step(inp.t, frame);
    frame = r.frame;

    const expFrame = fixture.frames[tick];
    const expPreload = fixture.preload[tick];
    const expMode = fixture.modes[tick];

    const frameMatch = frame === expFrame;
    const preloadMatch = r.preload.length === expPreload.length && r.preload.every((v, k) => v === expPreload[k]);
    const modeMatch = r.mode === expMode;

    if (frameMatch) framesOk++;
    if (preloadMatch) preloadOk++;
    if (modeMatch) modesOk++;

    ok(`tick ${tick} (t=${inp.t}): frame ${frame} === ${expFrame}`, frameMatch);
    ok(`tick ${tick} (t=${inp.t}): mode ${r.mode} === ${expMode}`, modeMatch);
    ok(
      `tick ${tick} (t=${inp.t}): preload [${r.preload}] === [${expPreload}]`,
      preloadMatch
    );
    tick++;
  }
}

console.log(
  `\nmocap matcher: ${pass} passed, ${fail} failed over ${tick} ticks ` +
    `(frames ${framesOk}/${tick}, preload ${preloadOk}/${tick}, modes ${modesOk}/${tick})`
);
if (failures.length) {
  console.log('\n' + failures.slice(0, 40).join('\n'));
  if (failures.length > 40) console.log(`... and ${failures.length - 40} more`);
  process.exit(1);
}
