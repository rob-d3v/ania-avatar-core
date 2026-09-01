/**
 * Unit tests for frame-rate resolution and clamping (utils/frame-rate.js).
 *
 * Run: node examples/test-frame-rate.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 *
 * The table in section 2 is the actual bug report, expressed as assertions: the
 * legacy speed values that nineteen consumer apps hardcode must all collapse
 * onto the clamp, because that is what lets those apps be fixed without editing
 * a single one of them.
 */
/**
 * Ported verbatim from `ania-avatar-react`'s test of the same name. The maths
 * is the same maths; only the import changes, because here it is TypeScript
 * compiled into `dist/`. Keeping the assertions identical is the point — it is
 * what proves the two packages behave the same.
 *
 * Run: npm run build && node examples/<this file>
 */

import {
  resolveNativeFps,
  frameIntervalMs,
  normalizeFpsClamp,
  fpsFromIntervalMs,
  FPS_CLAMP_DEFAULT,
  FPS_FALLBACK
} from '../dist/index.js';

let pass = 0;
let fail = 0;
const failures = [];

const ok = (name, cond) => {
  if (cond) pass++;
  else { fail++; failures.push(`✗ ${name}`); }
};
const eq = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    failures.push(`✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
};
const near = (name, actual, expected, tolerance) => {
  if (Math.abs(actual - expected) <= tolerance) pass++;
  else {
    fail++;
    failures.push(`✗ ${name}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`);
  }
};

// ---- 1. resolveNativeFps ----
eq('video.fps wins when present',
  resolveNativeFps({ video: { fps: 24 } }), { fps: 24, source: 'video.fps' });

// A studio-authored duration is fps-correct (~1000/fps) and is a valid source.
eq('a studio frame duration is used when fps is absent',
  resolveNativeFps({ config: { idleFrameDuration: 40 } }), { fps: 25, source: 'config.idleFrameDuration' });

// ...but 50 is the legacy "nobody set this" fallback, NOT a genuine 20 fps.
// Reading it as 20 fps would make every pre-studio avatar play 20% slow.
eq('the legacy 50 ms duration is not mistaken for 20 fps',
  resolveNativeFps({ config: { idleFrameDuration: 50 } }), { fps: FPS_FALLBACK, source: 'fallback' });

eq('frame count over duration is the last resort before guessing',
  resolveNativeFps({ video: { frames: new Array(240), duration: 10 } }),
  { fps: 24, source: 'frames/duration' });

for (const [label, bad] of [
  ['zero', { video: { fps: 0 } }],
  ['NaN', { video: { fps: NaN } }],
  ['negative', { video: { fps: -30 } }],
  ['absurd', { video: { fps: 500 } }],
  ['missing', {}],
  ['null', null]
]) {
  eq(`${label} fps falls through to the assumed rate`, resolveNativeFps(bad).fps, FPS_FALLBACK);
}

// ---- 2. The bug report as a table ----
// Every row is a real consumer configuration. `speed` is what the app passes
// today; `fps` is what the .ania actually is.
const CLAMP = FPS_CLAMP_DEFAULT;
//
// Note where the legacy rows land: at the CEILING (30), not at the footage's
// native rate. A legacy multiplier asks for something far faster than the
// window allows, so it pins to the fastest the window permits. That is the
// desired outcome — every app carrying the legacy preset converges on the same
// 30 fps regardless of what its .ania was shot at, which is precisely the
// "make it all consistent" the clamp exists for. Playing 24 fps footage at 30
// speeds the motion by 25%; running it at 128 fps, which is the status quo,
// is five times worse.
const rows = [
  // fps, speed, expected effective fps, note
  [24, 6.4, 30, 'the canonical preset (8 apps) pins to the ceiling'],
  [24, 5.3, 30, 'the canonical talk preset pins to the ceiling'],
  [24, 1, 24, 'unconfigured 24 fps footage plays as shot'],
  [30, 2.8, 30, 'diario-de-obra idle pins to the ceiling'],
  [30, 3.325, 30, 'diario-de-obra talk pins to the ceiling'],
  [30, 1, 30, 'unconfigured 30 fps footage plays as shot'],
  [60, 1, 30, '60 fps footage is held to the ceiling'],
  [12, 1, 24, '12 fps footage is lifted to the floor'],
  [25, 1, 25, 'a rate inside the window is untouched'],
  [24, 0.1, 24, 'an absurdly slow multiplier is lifted to the floor'],
  [24, 1.25, 30, 'a modest speed-up is still expressible'],
  [24, 0.8, 24, 'so is a modest slow-down (the window is only 1.25x wide)']
];
for (const [fps, speed, expected, note] of rows) {
  const interval = frameIntervalMs({ nativeFps: fps, speed, clamp: CLAMP });
  near(`${note}: ${fps}fps x${speed} -> ${expected}fps`, fpsFromIntervalMs(interval), expected, 0.01);
}

// The headline number from the bug report: 128 fps, gone.
{
  const before = 50 / 6.4; // what the runtime computes today
  const after = frameIntervalMs({ nativeFps: 24, speed: 6.4, clamp: CLAMP });
  ok(`the legacy path really did run at ~128 fps (${fpsFromIntervalMs(before).toFixed(0)})`,
    fpsFromIntervalMs(before) > 120);
  ok('the clamped path runs inside the window',
    fpsFromIntervalMs(after) >= CLAMP.min - 0.01 && fpsFromIntervalMs(after) <= CLAMP.max + 0.01);
}

// ---- 3. Clamp mechanics ----
near('an unclamped interval is the raw division',
  frameIntervalMs({ nativeFps: 24, speed: 6.4, clamp: null }), 1000 / 24 / 6.4, 1e-9);

near('playbackSpeed divides before the clamp is applied',
  frameIntervalMs({ nativeFps: 24, speed: 1, playbackSpeed: 2, clamp: null }), 1000 / 24 / 2, 1e-9);

ok('playbackSpeed cannot escape the clamp either',
  Math.abs(fpsFromIntervalMs(frameIntervalMs({ nativeFps: 24, playbackSpeed: 4, clamp: CLAMP })) - 30) < 0.01);

for (const [label, bad] of [['zero', 0], ['negative', -3], ['NaN', NaN], ['undefined', undefined]]) {
  near(`a ${label} speed is treated as 1`,
    frameIntervalMs({ nativeFps: 25, speed: bad, clamp: null }), 40, 1e-9);
}

near('a missing nativeFps falls back rather than dividing by zero',
  frameIntervalMs({ clamp: null }), 1000 / FPS_FALLBACK, 1e-9);

// ---- 4. normalizeFpsClamp ----
eq('undefined means the default window', normalizeFpsClamp(undefined), FPS_CLAMP_DEFAULT);
eq('true means the default window', normalizeFpsClamp(true), FPS_CLAMP_DEFAULT);
eq('false disables clamping entirely', normalizeFpsClamp(false), null);
eq('a valid custom window is honoured', normalizeFpsClamp({ min: 12, max: 60 }), { min: 12, max: 60 });
eq('an equal-bounds window is valid (pin to one rate)', normalizeFpsClamp({ min: 30, max: 30 }), { min: 30, max: 30 });

// A bad prop must degrade to correct playback, never to a blank avatar: this
// runs in a render path inside nineteen host apps.
{
  const original = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  const inverted = normalizeFpsClamp({ min: 60, max: 24 });
  const nonsense = normalizeFpsClamp({ min: 'fast', max: 'slow' });
  const tooHigh = normalizeFpsClamp({ min: 24, max: 500 });
  console.warn = original;
  eq('an inverted window falls back to the default', inverted, FPS_CLAMP_DEFAULT);
  eq('a non-numeric window falls back to the default', nonsense, FPS_CLAMP_DEFAULT);
  eq('an out-of-range ceiling falls back to the default', tooHigh, FPS_CLAMP_DEFAULT);
  ok('each bad window warns once', warned === 3);
}

// ---- 5. The escape hatch actually escapes ----
// A host that deliberately wants 128 fps can still have it. The clamp is a
// default, not a cage.
{
  const interval = frameIntervalMs({ nativeFps: 24, speed: 6.4, clamp: normalizeFpsClamp(false) });
  ok('fpsClamp={false} restores the full legacy behaviour', fpsFromIntervalMs(interval) > 120);
  const wide = frameIntervalMs({ nativeFps: 60, speed: 1, clamp: normalizeFpsClamp({ min: 24, max: 60 }) });
  near('a widened window admits 60 fps', fpsFromIntervalMs(wide), 60, 0.01);
}

// ---- Report ----
console.log(`\nframe rate: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
