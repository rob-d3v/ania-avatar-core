/**
 * Unit tests for the lip sync animator (lip-sync/animator.js).
 *
 * Run: node examples/test-lip-animator.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 *
 * The invariant this file guards hardest: EVERY branch moves the frame by at
 * most ±1 (branch B under the snap budget excepted). The source footage is a
 * continuous mouth cycle, so skipping frames inside it reads as a dropped frame,
 * not as speech. That is the difference between "the avatar is talking" and
 * "the avatar is glitching".
 */
/**
 * Ported verbatim from `ania-avatar-react`'s test of the same name. The maths
 * is the same maths; only the import changes, because here it is TypeScript
 * compiled into `dist/`. Keeping the assertions identical is the point — it is
 * what proves the two packages behave the same.
 *
 * Run: npm run build && node examples/<this file>
 */

import { LipAnimator, findClosedFrame } from '../dist/index.js';

let pass = 0;
let fail = 0;
const failures = [];

const ok = (name, cond) => {
  if (cond) pass++;
  else { fail++; failures.push(`✗ ${name}`); }
};
const near = (name, actual, expected, tolerance) => {
  if (Math.abs(actual - expected) <= tolerance) pass++;
  else {
    fail++;
    failures.push(`✗ ${name}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`);
  }
};

// The production tuning shipped in install_defaults.json on the desktop.
const PROD = { intensity: 0.79, responsiveness: 0.24 };
// The talk range of the reference avatar (NANDA_lips.json covers 581..831).
const TALK = { talkLow: 581, talkHigh: 831 };
const TICK = 16.667;

// ---- 1. The tuning constants, read off observable behaviour ----
// One tick from rest with a saturating input isolates the attack alpha:
// boosted = min(1, 1 * (0.4 + 1.6*0.79)) = 1, and envelope = 1 * aDt.
{
  const a = new LipAnimator(PROD);
  a.poll(TICK, 1);
  near('attack alpha is 0.696 at responsiveness 0.24', a.getEnvelope(), 0.696, 0.002);
}
// A half-scale input does not saturate, so the same tick also reveals the boost
// gain: 0.5 * 1.664 * 0.696 = 0.5791.
{
  const a = new LipAnimator(PROD);
  a.poll(TICK, 0.5);
  near('boost gain is 1.664 at intensity 0.79', a.getEnvelope(), 0.5791, 0.002);
}
// Release is deliberately slower than attack — the mouth opens ~1.65x faster
// than it closes, which is what reads as "articulate" rather than "twitchy".
{
  const a = new LipAnimator(PROD);
  for (let i = 0; i < 40; i++) a.poll(TICK, 1);
  a.poll(TICK, 0);
  near('release alpha is 0.422 at responsiveness 0.24', a.getEnvelope(), 0.578, 0.002);
}

// ---- 2. intervalScale — the envelope-modulated sweep speed ----
// This is the crux of the port. During speech the frame is NOT looked up from
// the openness map: the sweep runs faster when the audio is louder, and the
// talk range is itself an open-close mouth cycle, so a faster sweep is a
// busier mouth.
{
  const a = new LipAnimator(PROD);
  for (let i = 0; i < 200; i++) a.poll(TICK, 0);
  near('interval scale is 1.0 in silence', a.intervalScale(), 1, 0.001);
  for (let i = 0; i < 400; i++) a.poll(TICK, 1);
  near('interval scale bottoms out at 0.447 (2.237x sweep boost)', a.intervalScale(), 0.447, 0.002);
}
{
  // The desktop hard-floors this factor at 0.2, but at intensity 0.79 its own
  // minimum is 1 - 0.79*0.7 = 0.447, so the floor is never reached and
  // replacing it with 1/maxSweepBoost is a no-op at production settings.
  const a = new LipAnimator({ intensity: 1, responsiveness: 0.24, maxSweepBoost: 2.237 });
  for (let i = 0; i < 400; i++) a.poll(TICK, 1);
  ok('maxSweepBoost floors the scale even at intensity 1', a.intervalScale() >= 1 / 2.237 - 1e-9);
}

// ---- 3. The ±1 invariant, and staying in range ----
{
  const a = new LipAnimator(PROD);
  let frame = 600;
  let maxStep = 0;
  let outOfRange = false;
  const branches = new Set();
  for (let i = 0; i < 900; i++) {
    a.poll(TICK, 0.45 + 0.35 * Math.sin(i / 9));
    const next = a.step({ ...TALK, currentFrame: frame, opennessMap: null });
    maxStep = Math.max(maxStep, Math.abs(next - frame));
    if (next < TALK.talkLow || next > TALK.talkHigh) outOfRange = true;
    branches.add(a.lastBranch());
    frame = next;
  }
  ok(`frame never moves more than 1 per tick while voiced (max ${maxStep})`, maxStep <= 1);
  ok('frame never leaves the talk range', !outOfRange);
  ok('the voiced branch is the one being exercised', branches.has('voiced'));
}

// The sweep must bounce at BOTH ends rather than wrapping — a wrap is a jump
// cut from a wide-open mouth straight to a closed one.
{
  // The input must VARY. A constant one is exactly what the sustain detector is
  // built to latch onto, and branch A would run instead of the sweep.
  const a = new LipAnimator(PROD);
  const voiced = (i) => 0.6 + 0.35 * Math.sin(i);
  for (let i = 0; i < 40; i++) a.poll(TICK, voiced(i));

  let frame = TALK.talkHigh;
  const seen = [];
  for (let i = 0; i < 12; i++) {
    a.poll(TICK, voiced(40 + i));
    frame = a.step({ ...TALK, currentFrame: frame, opennessMap: null });
    seen.push(frame);
  }
  ok('sweep is in the voiced branch at the top of the range', a.lastBranch() === 'voiced');
  ok(
    'sweep reverses at the top of the range',
    seen.every((f) => f <= TALK.talkHigh) && seen[0] === TALK.talkHigh - 1
  );

  let low = TALK.talkLow;
  const seenLow = [];
  for (let i = 0; i < 12; i++) {
    a.poll(TICK, voiced(60 + i));
    low = a.step({ ...TALK, currentFrame: low, opennessMap: null });
    seenLow.push(low);
  }
  ok(
    'sweep reverses at the bottom of the range',
    seenLow.every((f) => f >= TALK.talkLow) && seenLow[0] === TALK.talkLow + 1
  );
}

// ---- 4. Branch selection ----
{
  const a = new LipAnimator(PROD);
  for (let i = 0; i < 60; i++) a.poll(TICK, 0);
  a.step({ ...TALK, currentFrame: 700, opennessMap: null });
  ok('silence branch is chosen below the silence threshold', a.lastBranch() === 'silence');

  const b = new LipAnimator(PROD);
  for (let i = 0; i < 3; i++) b.poll(TICK, 0.9);
  b.step({ ...TALK, currentFrame: 700, opennessMap: null });
  ok('voiced branch is chosen on a rising transient', b.lastBranch() === 'voiced');
}

// A held vowel: a stable input for long enough latches the sustain branch. The
// detector needs 6 samples in its 200 ms window before it will judge stability
// at all, then the counter has to climb to 8.
{
  const a = new LipAnimator(PROD);
  let enteredAt = null;
  for (let t = 0; t < 1200 && enteredAt === null; t += TICK) {
    a.poll(TICK, 0.5);
    a.step({ ...TALK, currentFrame: 700, opennessMap: null });
    if (a.lastBranch() === 'sustain') enteredAt = t;
  }
  ok(`sustain latches on a held vowel (at ${enteredAt} ms)`, enteredAt !== null && enteredAt < 400);

  // ...and lets go promptly once articulation resumes: the counter drains 3x
  // faster than it fills, so the wiggle gets out of the way of real speech.
  let leftAt = null;
  for (let t = 0; t < 1200 && leftAt === null; t += TICK) {
    a.poll(TICK, 0.2 + 0.6 * Math.random());
    a.step({ ...TALK, currentFrame: 700, opennessMap: null });
    if (a.lastBranch() !== 'sustain') leftAt = t;
  }
  ok(`sustain releases when articulation resumes (at ${leftAt} ms)`, leftAt !== null && leftAt < 300);
}

// ---- 5. Sustain styles ----
{
  const wiggle = new LipAnimator({ ...PROD, sustainStyle: 'wiggle', wiggleSpeed: 4 });
  let frame = 700;
  const frames = [];
  for (let i = 0; i < 200; i++) {
    wiggle.poll(TICK, 0.5);
    frame = wiggle.step({ ...TALK, currentFrame: frame, opennessMap: null });
    if (wiggle.lastBranch() === 'sustain') frames.push(frame);
  }
  const span = Math.max(...frames) - Math.min(...frames);
  ok(`wiggle oscillates around the anchor (span ${span} frames)`, span > 0 && span <= 8);
}
{
  // INTENTIONAL DIVERGENCE from the desktop, where 'hold' is a silent no-op
  // (animation_controller.py only handles 'wiggle'). lipSyncSustainStyle is a
  // documented public prop here, so it does what it says.
  const hold = new LipAnimator({ ...PROD, sustainStyle: 'hold' });
  let frame = 700;
  const held = [];
  for (let i = 0; i < 200; i++) {
    hold.poll(TICK, 0.5);
    frame = hold.step({ ...TALK, currentFrame: frame, opennessMap: null });
    if (hold.lastBranch() === 'sustain') held.push(frame);
  }
  ok('hold freezes on the anchor', held.length > 0 && new Set(held).size === 1);
}

// ---- 6. The close budget (branch B) ----
// A web-specific deviation: the desktop walks ±1 at 60 Hz, but we are clamped
// to 24-30 fps, so a ±1 walk across the talk range would take many seconds.
//
// This was a flat 3-frames-per-tick cap until a real browser run showed what
// that costs: the close time is proportional to the distance, the distance is
// wherever the sweep stopped, and on a 251-frame range the mouth took 1.9 s to
// shut after a sentence. No machine could do better — the cap, not the tick
// rate, was the bottleneck. So the budget became a deadline: close within
// `closeMs` of the gate going quiet, with the step derived from the measured
// tick, floored at `maxSnapStep` so short distances still animate, and ceilinged
// at a tenth of the range so it never reads as a cut.
{
  const map = new Array(251).fill(1);
  map[0] = 0; // the closed-mouth frame sits at the bottom of the range
  const a = new LipAnimator({ ...PROD, snapAfterMs: 250, maxSnapStep: 3 });
  for (let i = 0; i < 30; i++) a.poll(33.333, 0); // envelope to rest, gate closed > 250 ms

  let frame = TALK.talkHigh;
  let maxStep = 0;
  let ticks = 0;
  while (frame !== TALK.talkLow && ticks < 2000) {
    a.poll(33.333, 0);
    const next = a.step({ ...TALK, currentFrame: frame, opennessMap: map });
    maxStep = Math.max(maxStep, Math.abs(next - frame));
    frame = next;
    ticks++;
  }
  // A tenth of the range, which for this 251-frame range is 26.
  const ceiling = Math.ceil(251 * 0.1);
  ok(`close step never exceeds a tenth of the range (max ${maxStep}, ceiling ${ceiling})`, maxStep <= ceiling);
  ok('close does reach the closed frame', frame === TALK.talkLow);
  // The worst case that exists: a full 250-frame range at the slowest allowed
  // frame rate. This is the assertion the browser harness could not pass before
  // — it measured 1.9 s here.
  const closeMs = ticks * 33.333;
  ok(`worst-case close is under 600 ms (${closeMs.toFixed(0)} ms over ${ticks} ticks at 30 fps)`, closeMs < 600);
}
{
  // Before the budget arms, the walk is strictly ±1.
  const map = new Array(251).fill(1);
  map[0] = 0;
  const a = new LipAnimator({ ...PROD, snapAfterMs: 250, maxSnapStep: 3 });
  a.poll(33.333, 0);
  const next = a.step({ ...TALK, currentFrame: TALK.talkHigh, opennessMap: map });
  ok('the walk is ±1 until the snap budget arms', Math.abs(next - TALK.talkHigh) === 1);
}

// ---- 7. Degenerate input ----
{
  const a = new LipAnimator(PROD);
  a.poll(TICK, 0.5);
  const f = a.step({ currentFrame: 700, talkLow: 400, talkHigh: 400, opennessMap: null });
  ok('a zero-width talk range collapses to talkLow instead of producing NaN', f === 400);
  const g = a.step({ currentFrame: NaN, talkLow: 581, talkHigh: 831, opennessMap: null });
  ok('a NaN current frame is recovered, not propagated', Number.isFinite(g));
}

// ---- 8. reset() ----
// Called on the idle->talking edge, so the first syllable of a new utterance
// is not animated with the tail of the previous one.
{
  const a = new LipAnimator(PROD);
  for (let i = 0; i < 100; i++) a.poll(TICK, 1);
  a.reset();
  const fresh = new LipAnimator(PROD);
  a.poll(TICK, 0.5);
  fresh.poll(TICK, 0.5);
  near('reset() restores fresh-instance behaviour', a.getEnvelope(), fresh.getEnvelope(), 1e-12);
}

// ---- 9. findClosedFrame ----
{
  const map = [0.9, 0.5, 0.0, 0.5, 0.9];
  ok('picks the entry nearest to closed', findClosedFrame(map, 0, map.length) === 2);
  // The proximity term is a tiebreak only: among equally-closed frames the
  // nearer one wins, so the mouth does not teleport across the loop.
  const tied = [0.0, 0.9, 0.9, 0.9, 0.0];
  ok('breaks ties toward the nearer frame (from the left)', findClosedFrame(tied, 0, tied.length) === 0);
  ok('breaks ties toward the nearer frame (from the right)', findClosedFrame(tied, 4, tied.length) === 4);
  ok('no map falls back to talkLow', findClosedFrame(null, 3, 0) === 0);
  ok('empty map falls back to talkLow', findClosedFrame([], 3, 0) === 0);
}

// ---- Report ----
console.log(`\nlip sync animator: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
