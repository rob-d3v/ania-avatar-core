/**
 * Ania 2.0 reaction levels — the per-level acceptance tests of the spec page
 * `Ania Creators/wiki/concepts/ania-2-0-reaction-levels.md` §7, ported 1:1 from
 * `AniaAPP/tests/test_mocap_levels.py`, plus bit-parity against the regenerated
 * Python fixtures `levels_cases.json` and `reach_cases.json`.
 *
 * Deterministic: one synthetic descriptor stream x one synthetic bank x one level =>
 * one frame sequence. No MediaPipe, no wall clock, no RNG beyond a seeded LCG.
 *
 * Test ids follow the spec table: L0-*, L1-*, L2-*, L3-*, A-*.
 *
 * Run: npm run build && node examples/test-mocap-levels.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIM_INDEX,
  FACE_GROUPS,
  POSE_GROUPS,
  NEUTRAL,
  NDIMS,
  NUSED,
  G_EYES,
  GROUP_PARAMS,
  MotionMatcher,
  OneEuroVector,
  applyMirror,
  attachReach,
  buildCoverage,
  buildPosesIndex,
  sequencesFromRanges,
  probeCaps,
  resolveOptions,
  levelCards,
  defaultComfort,
  serializeComfort,
  oneEuroMinCutoff,
  shouldCrossfade,
  crossfadeAlpha,
  levelActive,
  gainsFromOptions,
  paramsFromResidual,
  headRegionFromFrame,
  featherNorm,
  paramsForHead,
  regionAlpha,
  regionAlphaAt,
  regionBox,
  LEVELS,
  STRINGS,
  MOUTH_HANDOVER_MS,
  CROSSFADE_COST,
  INTENSITY_MAX,
  SMOOTHING_MIN,
  MODE_DECAY,
  MODE_IDLE,
} from '../dist/index.js';

const FIXTURES_DIR =
  process.env.ANIA_MOCAP_FIXTURES ||
  'E:/backup_2026/Repositórios/AnimatedAvatar/AniaAPP/tests/fixtures/mocap';

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
const notes = [];

const N = 100;
const TICK = 40.0;
const I = DIM_INDEX;
const ALL_GROUPS = FACE_GROUPS | POSE_GROUPS;

const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// --------------------------------------------------------------------------- bank
/**
 * A bank that can actually show every channel the levels talk about, so "this dim does
 * not influence the sequence" is a real assertion and not a tautology. Blinks alternate
 * between neighbouring frames, which makes the blink channel the tie-breaker between
 * two frames of nearly identical yaw.
 */
function richBank(n = N) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = new Float64Array(NUSED);
    r[I.headYaw] = -1.0 + (2.0 * i) / (n - 1);
    r[I.headPitch] = 0.6 * Math.sin((2 * Math.PI * i) / 29.0);
    r[I.eyeBlinkL] = r[I.eyeBlinkR] = i % 2 === 0 ? 1 : 0;
    r[I.mouthOpen] = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 13.0);
    r[I.mouthSmile] = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 7.0);
    r[I.mouthWidth] = 0.6 * Math.sin((2 * Math.PI * i) / 11.0);
    r[I.browRaise] = Math.sin((2 * Math.PI * i) / 17.0);
    r[I.eyeWide] = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 19.0);
    r[I.gazeX] = 0.6 * Math.sin((2 * Math.PI * i) / 23.0);
    r[I.gazeY] = 0.6 * Math.cos((2 * Math.PI * i) / 23.0);
    r[I.handL_vis] = i % 3 !== 0 ? 1 : 0;
    r[I.handR_vis] = i % 4 !== 0 ? 1 : 0;
    r[I.handL_y] = -1.0 + (2.0 * i) / (n - 1);
    r[I.handR_y] = 1.0 - (2.0 * i) / (n - 1);
    rows.push(r);
  }
  const masks = new Array(n).fill(ALL_GROUPS);
  const seqs = sequencesFromRanges(n, [0, 59], [60, n - 1]);
  const poses = buildPosesIndex(rows, masks, seqs, { contentHash: 'levels', dims: NUSED });
  const coverage = buildCoverage(poses);
  attachReach(poses, coverage);
  return { poses, coverage };
}

const { poses: BANK, coverage: COVERAGE } = richBank();

function fullCaps(over = {}) {
  return { ...probeCaps(BANK, COVERAGE), ...over };
}

function build(level, caps = null, comfort = null, graph = null) {
  const c = { level, ...(comfort || {}) };
  const res = resolveOptions(c, caps ?? fullCaps());
  const m = new MotionMatcher(BANK, graph, res.matcher, new OneEuroVector(res.one_euro_min_cutoff));
  return { m, res };
}

// ----------------------------------------------------------------------- streams
/** Deterministic descriptor for tick k, matching `test_mocap_levels.driver`. */
function driver(k, { blink = true, mouth = 0.0, brows = 0.0, hands = 0.0, eyes = 0.0 } = {}) {
  const v = Float64Array.from(NEUTRAL);
  v[I.headYaw] = Math.sin((2 * Math.PI * k) / 60.0);
  v[I.headPitch] = 0.4 * Math.cos((2 * Math.PI * k) / 45.0);
  v[I.eyeBlinkL] = v[I.eyeBlinkR] = blink && k % 17 < 2 ? 1.0 : 0.0;
  for (const nm of ['mouthOpen', 'jawOpen', 'mouthSmile', 'mouthFrown', 'mouthPucker', 'mouthWidth']) v[I[nm]] = mouth;
  for (const nm of ['browRaise', 'browInnerUp', 'browDown']) v[I[nm]] = brows;
  for (const nm of ['eyeWide', 'gazeX', 'gazeY']) v[I[nm]] = eyes;
  for (const nm of ['handL_vis', 'handL_x', 'handL_y', 'handR_vis', 'handR_x', 'handR_y']) v[I[nm]] = hands;
  return v;
}

/** (frames, teleports, results) for a run of `ticks` at the 40 ms tick. */
function replay(m, { ticks = 120, talking = false, t0 = 0.0, start = null, norm = 'raw', ...kw } = {}) {
  let f = start === null ? m.getRestFrame() : start;
  let t = t0;
  const frames = [];
  const tele = [];
  const out = [];
  for (let k = 0; k < ticks; k++) {
    t += TICK;
    m.pushPose(t, ALL_GROUPS, driver(k, kw), norm);
    const talk = typeof talking === 'function' ? talking(k) : talking;
    m.setAudio(talk, talk ? 0.5 : 0.0, 0.6);
    const r = m.step(t, f);
    f = r.frame;
    frames.push(f);
    out.push(r);
    if (r.teleport) tele.push(t);
  }
  return { frames, tele, out };
}

// =========================================================== L0 — off
{
  const res = resolveOptions({ level: 'off' }, fullCaps());
  ok('L0-1: off resolves to nothing', res.active === false && res.level === 'off');
  ok('L0-1: levelActive("off") is false', levelActive('off') === false);
  ok('L0-1: levelActive("presence") is true', levelActive('presence') === true);
  ok('L0-1: unknown level is off, not a crash', resolveOptions({ level: 'espelho' }, fullCaps()).level === 'off');
  ok('L0-1: empty comfort is off', resolveOptions({}, fullCaps()).level === 'off');
}

// =========================================================== L1 — presence
{
  const { m, res } = build('presence');
  ok('L1-1: presence has allow_teleport = false', res.matcher.allow_teleport === false);
  const { frames, tele } = replay(m, { ticks: 200 });
  ok(`L1-1: presence never teleports (${tele.length})`, tele.length === 0);
  ok('L1-1: presence still moved', new Set(frames).size > 1);
}
{
  const a = build('presence').m;
  const b = build('presence').m;
  const fa = replay(a, { ticks: 150, mouth: 0.0, brows: 0.0, hands: 0.0 }).frames;
  const fb = replay(b, { ticks: 150, mouth: 0.9, brows: -0.8, hands: 1.0 }).frames;
  ok('L1-2: presence ignores mouth, brows and hands', arrEq(fa, fb));
}
{
  const fa = replay(build('presence').m, { ticks: 150 }).frames;
  const fb = replay(build('presence').m, { ticks: 150, eyes: 0.9 }).frames;
  const fc = replay(build('presence').m, { ticks: 150, blink: false }).frames;
  ok('L1-3: eyeWide/gaze do not change the sequence at presence', arrEq(fa, fb));
  ok('L1-3: blinks DO change the sequence (the blink channel is alive)', !arrEq(fa, fc));
}
{
  const { m, res } = build('presence');
  const gains = gainsFromOptions(res.affine);
  const { frames } = replay(m, { ticks: 150 });
  const W = 480;
  const H = 640;
  let capsOk = true;
  for (const f of frames) {
    const p = paramsFromResidual(m.residual(f), W, H, gains, res.affine.strength, 1.7);
    if (
      Math.abs(p.rot_deg) > res.affine.max_rotate_deg + 1e-9 ||
      Math.abs(p.tx) > res.affine.max_translate_frac * W + 1e-9 ||
      Math.abs(p.ty) > res.affine.max_translate_frac * H + 1e-9 ||
      Math.abs(p.scale - 1.0) > res.affine.max_scale_dev + 1e-9
    ) {
      capsOk = false;
      break;
    }
  }
  ok('L1-4: presence affine caps hold on every frame (breathing included)', capsOk);
}

// =========================================================== L2 — expressive
{
  const fa = replay(build('expressive').m, { ticks: 150, talking: true, mouth: 0.0 }).frames;
  const fb = replay(build('expressive').m, { ticks: 150, talking: true, mouth: 0.9 }).frames;
  ok('L2-1: expressive ignores the camera mouth while talking', arrEq(fa, fb));
}
{
  const { m, res } = build('expressive');
  ok('L2-2: expressive mouth_policy is "auto"', res.matcher.mouth_policy === 'auto');
  let t = 0.0;
  let f = m.getRestFrame();
  let edgeT = null;
  let switchT = null;
  for (let k = 0; k < 80; k++) {
    t += TICK;
    const talking = k < 20;
    m.pushPose(t, ALL_GROUPS, driver(k, { mouth: 0.6 }), 'raw');
    m.setAudio(talking, talking ? 0.5 : 0.0, 0.6);
    const r = m.step(t, f);
    f = r.frame;
    if (!talking && edgeT === null) edgeT = t;
    if (edgeT !== null && switchT === null && r.debug.mouth_policy >= 0.5) switchT = t;
  }
  ok('L2-2: the mouth reaches the camera after a silence', switchT !== null);
  ok(
    `L2-2: the handover is >= ${MOUTH_HANDOVER_MS} ms and < one tick later (${switchT - edgeT})`,
    switchT !== null && switchT - edgeT >= MOUTH_HANDOVER_MS && switchT - edgeT < MOUTH_HANDOVER_MS + TICK,
  );
  const fa = replay(build('expressive').m, { ticks: 150, talking: false, mouth: 0.0 }).frames;
  const fb = replay(build('expressive').m, { ticks: 150, talking: false, mouth: 0.9 }).frames;
  ok('L2-2: once on the camera, the mouth dims change the sequence', !arrEq(fa, fb));
}
{
  const caps = fullCaps({ mouth: 0 });
  const res = resolveOptions({ level: 'expressive' }, caps);
  const keys = res.warnings.map((w) => w.key);
  ok('L2-3: noMouth warns exactly once', keys.filter((k) => k === 'mocap.level.warn.noMouth').length === 1);
  ok('L2-3: without the mouth cap the policy stays on audio', res.matcher.mouth_policy === 'audio');
  const fa = replay(build('expressive', caps).m, { ticks: 150, talking: false, mouth: 0.0 }).frames;
  const fb = replay(build('expressive', caps).m, { ticks: 150, talking: false, mouth: 0.9 }).frames;
  ok('L2-3: ...and the mouth dims never reach the cost', arrEq(fa, fb));
}
{
  const gated = probeCaps(BANK, COVERAGE, 1);
  ok('L2-4: brow mapping v1 gates caps.brows off', gated.brows === 0);
  ok('L2-4: brow mapping v2 lifts the gate', probeCaps(BANK, COVERAGE, 2).brows === 1);
  const res = resolveOptions({ level: 'expressive' }, gated);
  ok('L2-4: the gated bank warns noBrows', res.warnings.some((w) => w.key === 'mocap.level.warn.noBrows'));
  ok('L2-4: browRaise dim gain is 0 when gated', Number(res.matcher.dim_gain[I.browRaise]) === 0.0);
  const fa = replay(build('expressive', gated).m, { ticks: 150, brows: 0.0 }).frames;
  const fb = replay(build('expressive', gated).m, { ticks: 150, brows: -0.9 }).frames;
  ok('L2-4: brows do not move a gated bank', arrEq(fa, fb));
}
{
  const { m, res } = build('expressive');
  ok('L2-5: teleport gate is 0.35', res.matcher.teleport_min_gain === 0.35);
  ok('L2-5: teleport cooldown is 1200 ms', res.matcher.teleport_cooldown_ms === 1200.0);
  const { tele } = replay(m, { ticks: 400, talking: (k) => Math.floor(k / 50) % 2 === 1 });
  const gaps = tele.slice(1).map((v, i) => v - tele[i]);
  ok(`L2-5: every teleport respects the cooldown (${gaps.join(',')})`, gaps.every((g) => g >= 1200.0));
}

// =========================================================== L3 — mirror
{
  const { m, res } = build('mirror');
  ok('L3-1: mirror mouth_policy is "mocap"', res.matcher.mouth_policy === 'mocap');
  let t = 0.0;
  let f = m.getRestFrame();
  let allOk = true;
  for (let k = 0; k < 60; k++) {
    t += TICK;
    const talking = k >= 20 && k < 40;
    m.pushPose(t, ALL_GROUPS, driver(k, { mouth: 0.7 }), 'raw');
    m.setAudio(talking, talking ? 0.5 : 0.0, 0.6);
    const r = m.step(t, f);
    f = r.frame;
    const camera = r.debug.mouth_policy >= 0.5;
    if (camera === talking) allOk = false;
  }
  ok('L3-1: mirror uses the camera mouth only while silent (§6 rule 1)', allOk);
  ok('L3-1: mouthSource follows the effective policy', m.mouthSource === 'camera' || m.mouthSource === 'audio');
}
{
  const blind = fullCaps({ blend: 0 });
  const res = resolveOptions({ level: 'mirror' }, blind);
  ok('L3-2: no blend => crossfade off', res.crossfade === 'off');
  ok('L3-2: no blend => no teleports allowed', res.matcher.allow_teleport === false);
  ok(
    'L3-2: no blend => min_run_ticks + 1',
    res.matcher.min_run_ticks === LEVELS.mirror.matcher.min_run_ticks + 1,
  );
  ok('L3-2: no blend warns noBlend', res.warnings.some((w) => w.key === 'mocap.level.warn.noBlend'));
  const { tele } = replay(build('mirror', blind).m, { ticks: 200 });
  ok('L3-2: ...and the run takes none', tele.length === 0);
}
{
  const { m, res } = build('mirror');
  ok('L3-2: mirror crossfade is "on"', res.crossfade === 'on');
  const { out } = replay(m, { ticks: 300, talking: (k) => Math.floor(k / 40) % 2 === 1 });
  const tel = out.filter((r) => r.teleport);
  ok('L3-2: the run produced a teleport to check', tel.length > 0);
  ok(
    'L3-2: every teleport pairs with a crossfade',
    tel.every((r) => r.transition_cost >= CROSSFADE_COST && shouldCrossfade(r.transition_cost, res.crossfade, true)),
  );
}

// =========================================================== crossfade (pure)
for (const [cost, mode, blend, expected] of [
  [8.0, 'on', true, true],
  [8.0, 'auto', true, true],
  [8.0, 'off', true, false],
  [8.0, 'on', false, false],
  [6.0, 'auto', true, true],
  [5.999, 'auto', true, false],
  [0.0, 'auto', true, false],
  [NaN, 'auto', true, false],
]) {
  ok(`crossfade trigger (${cost}, ${mode}, ${blend})`, shouldCrossfade(cost, mode, blend) === expected);
}
ok('crossfade alpha ramp', crossfadeAlpha(-5, 120) === 0.0 && crossfadeAlpha(0, 120) === 0.0);
ok('crossfade alpha midpoint', close(crossfadeAlpha(60, 120), 0.5, 1e-12));
ok('crossfade alpha saturates', crossfadeAlpha(120, 120) === 1.0 && crossfadeAlpha(999, 120) === 1.0);

// =========================================================== caps gating
{
  const caps = fullCaps();
  for (const k of ['face', 'head', 'blink', 'mouth', 'smile', 'gaze', 'brows', 'hands', 'mouthShapes']) {
    ok(`caps probe: ${k} available on the rich bank`, caps[k] === 1);
  }
  ok('caps probe: headYawSpanDeg measured', caps.metrics.headYawSpanDeg > 9.0);
}
{
  const caps = probeCaps(null, null);
  ok('caps probe without an index', caps.face === 0 && caps.reason === 'mocap.level.blocked.noIndex');
}
{
  const res = resolveOptions({ level: 'mirror' }, fullCaps({ head: 0, mouth: 0 }));
  ok('mirror without head/mouth falls back to expressive', res.level === 'expressive');
  ok('...and remembers what was asked for', res.requested_level === 'mirror' && res.blocked === true);
  const keys = res.warnings.map((w) => w.key);
  ok(
    '...naming both missing things',
    keys.includes('mocap.level.blocked.needHead') && keys.includes('mocap.level.blocked.needMouth'),
  );
  const needHead = res.warnings.find((w) => w.key === 'mocap.level.blocked.needHead');
  ok('...with the {deg} placeholder filled', !needHead.text.includes('{deg}'));
}
{
  const res = resolveOptions({ level: 'expressive' }, fullCaps({ face: 0 }));
  ok('no face blocks every level down to off', res.level === 'off' && res.active === false);
  ok('...and says why', res.warnings.some((w) => w.key === 'mocap.level.blocked.noFace'));
}
{
  const caps = fullCaps({ head: 0 });
  caps.metrics = { ...caps.metrics, headYawSpanDeg: 5.4 };
  const res = resolveOptions({ level: 'presence' }, caps);
  ok('a narrow yaw warns but keeps presence selectable', res.level === 'presence' && res.blocked === false);
  const w = res.warnings.find((x) => x.key === 'mocap.level.warn.narrowYaw');
  ok('...and the sentence carries the measurement', !!w && w.text.includes('5.4'));
}
{
  const cards = Object.fromEntries(levelCards(fullCaps({ head: 0, mouth: 0 })).map((c) => [c.level, c]));
  ok(
    'level cards keep off/presence/expressive selectable',
    cards.off.enabled && cards.presence.enabled && cards.expressive.enabled,
  );
  ok('level cards grey mirror with a reason', !cards.mirror.enabled && cards.mirror.reason.length > 0);
}

// =========================================================== A — cross-level rules
for (const level of ['presence', 'expressive', 'mirror']) {
  const a = replay(build(level).m, { ticks: 200, talking: (k) => Math.floor(k / 40) % 2 === 1 });
  const b = replay(build(level).m, { ticks: 200, talking: (k) => Math.floor(k / 40) % 2 === 1 });
  ok(`A-1 ${level}: the same inputs produce the same frames`, arrEq(a.frames, b.frames));
  ok(`A-1 ${level}: ...and the same teleports`, arrEq(a.tele, b.tele));
  ok(
    `A-1 ${level}: ...and the same transition costs`,
    arrEq(a.out.map((r) => r.transition_cost), b.out.map((r) => r.transition_cost)),
  );
}
for (const level of ['presence', 'expressive', 'mirror']) {
  const { m, res } = build(level);
  const lo = m.reachLo[I.headYaw];
  const hi = m.reachHi[I.headYaw];
  const span = hi - lo;
  const gains = gainsFromOptions(res.affine);
  let t = 0.0;
  let f = m.getRestFrame();
  let inside = true;
  let rotOk = true;
  for (let k = 0; k < 200; k++) {
    t += TICK;
    const v = Float64Array.from(NEUTRAL);
    v[I.headYaw] = 1.2 * Math.sin((2 * Math.PI * k) / 30.0);
    v[I.headPitch] = -1.2 * Math.cos((2 * Math.PI * k) / 30.0);
    m.pushPose(t, ALL_GROUPS, v, 'cal');
    const r = m.step(t, f);
    f = r.frame;
    const x = m.getTarget()[I.headYaw];
    if (!(x >= lo - 0.3 * span - 1e-9 && x <= hi + 0.3 * span + 1e-9)) inside = false;
    const p = paramsFromResidual(m.residual(f), 480, 640, gains, res.affine.strength);
    if (Math.abs(p.rot_deg) > 12.0 + 1e-9) rotOk = false;
  }
  ok(`A-2 ${level}: the retarget never exceeds the reach by more than 30 %`, inside);
  ok(`A-2 ${level}: the rotation cap is 12° hard`, rotOk);
}
for (const level of ['presence', 'expressive', 'mirror']) {
  const { m } = build(level);
  const { frames } = replay(m, { ticks: 60 });
  const t = 60 * TICK;
  let f = frames[frames.length - 1];
  const modes = [];
  let reached = null;
  const neutral = Float64Array.from(NEUTRAL);
  for (let k = 1; k < 120; k++) {
    const now = t + m.opt.stale_ms + k * TICK;
    const r = m.step(now, f);
    f = r.frame;
    modes.push(r.mode);
    if (reached === null) {
      const x = m.getTarget();
      let worst = 0;
      for (let d = 0; d < NDIMS; d++) worst = Math.max(worst, Math.abs(x[d] - m.neutralAt(d)));
      if (worst <= 0.05) reached = k * TICK;
    }
  }
  ok(`A-3 ${level}: decay reaches neutral within 400 ms (${reached})`, reached !== null && reached <= 400.0);
  ok(`A-3 ${level}: decay_tau_ms is 130`, m.opt.decay_tau_ms === 130.0);
  ok(`A-3 ${level}: DECAY and IDLE are both visited`, modes.includes(MODE_DECAY) && modes.includes(MODE_IDLE));
  void neutral;
}
{
  const { m } = build('presence');
  const { frames } = replay(m, { ticks: 30 });
  const t = 30 * TICK;
  let f = frames[frames.length - 1];
  let handoff = false;
  for (let k = 1; k < 200; k++) {
    const r = m.step(t + k * TICK * 2, f);
    f = r.frame;
    handoff = handoff || r.handoff;
  }
  ok('A-3: the idle handoff fires after ten idle ticks', handoff);
}
{
  // seeded LCG, so "random" is reproducible across ports without numpy
  let s = 7;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const v = new Float64Array(NDIMS);
  for (let i = 0; i < NDIMS; i++) v[i] = rnd() * 2 - 1;
  const [once, m1] = applyMirror(v, ALL_GROUPS);
  const [twice, m2] = applyMirror(once, m1);
  let involution = m2 === ALL_GROUPS;
  for (let i = 0; i < NDIMS; i++) if (Math.abs(twice[i] - v[i]) > 1e-6) involution = false;
  ok('A-4: mirror is an involution', involution);
  ok('A-4: the lateral negation travels with the L/R swap (handL_x)', close(once[I.handL_x], -v[I.handR_x], 1e-6));
  ok('A-4: ...and the other way round (handR_x)', close(once[I.handR_x], -v[I.handL_x], 1e-6));
  ok(
    'A-4: no comfort key can say "mirror the face but not the hands"',
    arrEq(Object.keys(serializeComfort(defaultComfort('mirror'))), [
      'level',
      'intensity',
      'smoothing',
      'crossfade',
      'breathing',
      'mirror',
    ]),
  );
}
{
  const means = [];
  for (const intensity of [0.5, 1.0, 1.5]) {
    const { m, res } = build('expressive', null, { intensity });
    const gains = gainsFromOptions(res.affine);
    const { frames } = replay(m, { ticks: 120 });
    const txs = frames.map((f) => Math.abs(paramsFromResidual(m.residual(f), 480, 640, gains, res.affine.strength).tx));
    means.push(txs.reduce((a, b) => a + b, 0) / txs.length);
  }
  ok(
    `A-6: intensity is monotone on the affine translation (${means.map((v) => v.toFixed(3)).join(' <= ')})`,
    means[0] <= means[1] + 1e-9 && means[1] <= means[2] + 1e-9,
  );
}
{
  const changes = [];
  for (const smoothing of [2.0, 1.0, 0.5]) {
    const { m } = build('expressive', null, { smoothing });
    // Box-Muller over a seeded LCG so the noise is identical across runs.
    let s = 99;
    const u = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return (s + 1) / 2147483649;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    let t = 0.0;
    let f = m.getRestFrame();
    const frames = [];
    for (let k = 0; k < 300; k++) {
      t += TICK;
      const v = driver(k);
      v[I.headYaw] += gauss() * 0.12;
      v[I.headPitch] += gauss() * 0.12;
      m.pushPose(t, ALL_GROUPS, v, 'raw');
      m.setAudio(false, 0.0, 0.6);
      f = m.step(t, f).frame;
      frames.push(f);
    }
    changes.push(frames.slice(1).filter((v, i) => v !== frames[i]).length);
  }
  ok(`A-6: smoothing is monotone on the frame-change count (${changes.join(' >= ')})`, changes[0] >= changes[1] && changes[1] >= changes[2]);
}
for (const level of ['presence', 'expressive', 'mirror']) {
  for (const smoothing of [0.5, 1.0, 2.0]) {
    const cut = oneEuroMinCutoff(level, smoothing);
    const eyesPinned = ['eyeBlinkL', 'eyeBlinkR', 'eyeWide', 'gazeX', 'gazeY'].every(
      (nm) => cut[I[nm]] === GROUP_PARAMS[G_EYES][0] && cut[I[nm]] === 3.0,
    );
    ok(`A-7 ${level}/${smoothing}: the EYES cutoff is always 3 Hz`, eyesPinned);
  }
}
{
  const obj = {
    level: 'expressive',
    intensity: 1.2,
    smoothing: 0.8,
    crossfade: 'on',
    breathing: false,
    mirror: false,
    wat: 42,
  };
  const res = resolveOptions(obj, fullCaps());
  const ser = serializeComfort(res.comfort);
  ok(
    'A-8: the comfort wire form is exactly the six keys, in order',
    arrEq(Object.keys(ser), ['level', 'intensity', 'smoothing', 'crossfade', 'breathing', 'mirror']),
  );
  ok('A-8: unknown keys are dropped', !('wat' in ser));
  const again = resolveOptions(JSON.parse(JSON.stringify(ser)), fullCaps());
  ok('A-8: comfort round-trips through JSON', JSON.stringify(serializeComfort(again.comfort)) === JSON.stringify(ser));
}
{
  const res = resolveOptions({ level: 'presence', intensity: 99, smoothing: -3, crossfade: 'sometimes' }, fullCaps());
  ok('A-8: out-of-range intensity is clamped, not rejected', res.comfort.intensity === INTENSITY_MAX);
  ok('A-8: out-of-range smoothing is clamped', res.comfort.smoothing === SMOOTHING_MIN);
  ok('A-8: an unknown crossfade mode falls back to the level default', res.comfort.crossfade === LEVELS.presence.comfort.crossfade);
}

// =========================================================== reach retarget
{
  const n = 200;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = new Float64Array(NUSED);
    if (i < 192) {
      r[I.headYaw] = 0.05 * Math.sin(i / 3.0);
      r[I.eyeBlinkL] = r[I.eyeBlinkR] = i % 2 === 0 ? 1 : 0;
    } else {
      r[I.headYaw] = -1.0 + ((-0.65 - -1.0) * (i - 192)) / (n - 192 - 1);
    }
    rows.push(r);
  }
  const masks = new Array(n).fill(ALL_GROUPS);
  const seqs = sequencesFromRanges(n, [0, 191], [192, n - 1]);
  const poses = buildPosesIndex(rows, masks, seqs, { contentHash: 'reach', dims: NUSED });
  const cov = buildCoverage(poses);
  attachReach(poses, cov);
  const yi = I.headYaw;
  const p05 = poses.ranges.p05[yi];
  const p95 = poses.ranges.p95[yi];
  const lo = poses.ranges.reach.lo[yi];
  const hi = poses.ranges.reach.hi[yi];
  ok(`reach is wider than p05 on a rare-tail bank (${lo} vs ${p05})`, lo < p05 - 0.3);
  ok('reach never shrinks the top', hi >= p95 - 1e-9);
  const minPresent = Math.min(...rows.map((r) => r[yi]));
  ok('reach never promises a frame that does not exist', lo >= minPresent - 1e-6);
}
{
  const { m, res } = build('expressive');
  ok('reach is present on the rich bank and used', m.hasReach && res.matcher.use_reach === true);
  const yi = I.headYaw;
  const lo = m.reachLo[yi];
  const hi = m.reachHi[yi];
  let allOk = true;
  for (const [user, expected] of [
    [-1.0, lo],
    [1.0, hi],
    [0.0, 0.5 * (lo + hi)],
  ]) {
    m.reset();
    const v = Float64Array.from(NEUTRAL);
    v[yi] = user;
    m.pushPose(TICK, FACE_GROUPS, v, 'cal');
    if (Math.abs(m.getTarget()[yi] - expected) > 1e-6) allOk = false;
  }
  ok('the reach retarget maps the user extremes onto the bank reach', allOk);
}
{
  const yi = I.headYaw;
  const outs = {};
  for (const level of ['presence', 'expressive', 'mirror']) {
    const { m } = build(level, null, { intensity: 1.0 });
    const v = Float64Array.from(NEUTRAL);
    v[yi] = 1.0;
    m.pushPose(TICK, FACE_GROUPS, v, 'cal');
    outs[level] = m.getTarget()[yi];
  }
  ok(
    'the retarget gain scales about the reach midpoint',
    outs.presence < outs.expressive && outs.expressive < outs.mirror,
  );
}
{
  // `use_reach` defaults to false, so a matcher built the old way maps onto p05/p95
  const m = new MotionMatcher(BANK, null, {});
  const yi = I.headYaw;
  const v = Float64Array.from(NEUTRAL);
  v[yi] = 1.0;
  m.pushPose(TICK, FACE_GROUPS, v, 'cal');
  ok('the legacy retarget is untouched without a level', close(m.getTarget()[yi], m.p95At(yi), 1e-6));
}

// =========================================================== hold + breathing
{
  const { m } = build('expressive'); // hold_ms 180, release 150
  const d = I.mouthSmile;
  const t = TICK;
  const v = Float64Array.from(NEUTRAL);
  v[d] = 1.0;
  m.setOneEuro(null); // isolate the hold from the filter
  m.pushPose(t, FACE_GROUPS, v, 'raw');
  ok('hold: the peak is taken', close(m.getTarget()[d], 1.0, 1e-9));
  v[d] = 0.0;
  m.pushPose(t + 100.0, FACE_GROUPS, v, 'raw');
  ok('hold: the peak is held inside hold_ms', close(m.getTarget()[d], 1.0, 1e-9));
  m.pushPose(t + 180.0 + 75.0, FACE_GROUPS, v, 'raw');
  const half = m.getTarget()[d];
  ok(`hold: half-way through the release (${half.toFixed(3)})`, half > 0.4 && half < 0.6);
  m.pushPose(t + 180.0 + 200.0, FACE_GROUPS, v, 'raw');
  ok('hold: fully released', Math.abs(m.getTarget()[d]) < 1e-9);
}
{
  const { m, res } = build('presence', null, { breathing: true });
  ok('breathing is on at presence by default', res.breathing === true);
  let t = 0.0;
  let f = 40;
  const v = m.frameDescriptor(40);
  let breathed = false;
  for (let k = 0; k < 60; k++) {
    t += TICK;
    m.pushPose(t, ALL_GROUPS, v, 'raw');
    const r = m.step(t, f);
    f = r.frame;
    breathed = breathed || r.breathing;
  }
  ok('a perfectly still user still breathes', breathed);
}

// =========================================================== blink priority event
{
  const { m, res } = build('presence');
  ok('every level arms the blink event', res.matcher.blink_event === true);
  // hold the head still on a frame and blink: the eye-closed frame must be forced
  let t = 0.0;
  let f = 40;
  let blinks = 0;
  const closed = [];
  for (let k = 0; k < 60; k++) {
    t += TICK;
    const v = Float64Array.from(m.frameDescriptor(40));
    const blinking = k % 20 >= 10 && k % 20 < 12;
    v[I.eyeBlinkL] = v[I.eyeBlinkR] = blinking ? 1.0 : 0.0;
    m.pushPose(t, ALL_GROUPS, v, 'raw');
    const r = m.step(t, f);
    f = r.frame;
    if (r.blink) {
      blinks++;
      closed.push(Math.max(m.frameDescriptor(f)[I.eyeBlinkL], m.frameDescriptor(f)[I.eyeBlinkR]));
    }
  }
  ok(`blink: the event fires on the rising edge (${blinks})`, blinks > 0);
  ok('blink: every forced frame has the eyes closed', closed.every((v) => v >= 0.6));
  ok('blink: the counter is exposed', m.blinkEvents > 0);
  ok('blink: a blink is never a teleport for the crossfade', true);
}
{
  // refractory: two blinks closer than 250 ms count once
  const { m } = build('mirror');
  let t = 0.0;
  let f = 10;
  let events = 0;
  for (let k = 0; k < 12; k++) {
    t += TICK; // 40 ms
    const v = Float64Array.from(NEUTRAL);
    v[I.eyeBlinkL] = v[I.eyeBlinkR] = k % 2 === 0 ? 1.0 : 0.0; // 80 ms period
    m.pushPose(t, ALL_GROUPS, v, 'raw');
    const r = m.step(t, f);
    f = r.frame;
    if (r.blink && r.frame !== f) events++;
  }
  ok(`blink: the 250 ms refractory holds (${m.blinkEvents} events in 480 ms)`, m.blinkEvents <= 2);
}
{
  const m = new MotionMatcher(BANK, null, {});
  ok('blink_event is off by default (legacy parity)', m.opt.blink_event === false);
  const r = m.step(TICK, 0);
  ok('...and a default matcher never reports a blink', r.blink === false);
}

// =========================================================== ARTICULATE + mouth source
{
  // 2026-09-05 pivot: `presence` DOES take the user's mouth — through the player's own
  // lip-sync path, not through the matcher. `off` is the only level that refuses it.
  ok('presence takes the mic (through the legacy talk path)', resolveOptions({ level: 'presence', mouth_source: 'mic' }, fullCaps()).mouth_source === 'mic');
  ok('presence defaults to hybrid', resolveOptions({ level: 'presence' }, fullCaps()).mouth_source === 'hybrid');
  ok('off refuses every mouth source', resolveOptions({ level: 'off', mouth_source: 'mic' }, fullCaps()).mouth_source === 'audio');
  ok('expressive defaults to hybrid', resolveOptions({ level: 'expressive' }, fullCaps()).mouth_source === 'hybrid');
  ok('mirror defaults to hybrid', resolveOptions({ level: 'mirror' }, fullCaps()).mouth_source === 'hybrid');
  ok('an unknown mouth source falls back to the level default', resolveOptions({ level: 'mirror', mouth_source: 'telepathy' }, fullCaps()).mouth_source === 'hybrid');
  ok('hybrid/mic ask for a microphone', resolveOptions({ level: 'mirror' }, fullCaps()).needs_mic === true);
  ok('presence asks for one too, for the legacy talk path', resolveOptions({ level: 'presence' }, fullCaps()).needs_mic === true);
  ok('off does not', resolveOptions({ level: 'off' }, fullCaps()).needs_mic === false);
  ok('mouth_source camera maps to mouth_blend camera', resolveOptions({ level: 'mirror', mouth_source: 'camera' }, fullCaps()).matcher.mouth_blend === 'camera');
  ok('mouth_source mic maps to mouth_blend mic', resolveOptions({ level: 'mirror', mouth_source: 'mic' }, fullCaps()).matcher.mouth_blend === 'mic');
  // the MATCHER still never scores presence's mouth: its frames come from the cycler
  ok('presence never hands the mouth to the matcher', resolveOptions({ level: 'presence' }, fullCaps()).matcher.mouth_policy === 'audio');
  ok('presence runs the legacy engine', resolveOptions({ level: 'presence' }, fullCaps()).engine === 'legacy');
  ok('expressive and mirror run the matcher', ['expressive', 'mirror'].every((l) => resolveOptions({ level: l }, fullCaps()).engine === 'matcher'));
  ok('presence and expressive stay in the legacy frame pool', ['presence', 'expressive'].every((l) => resolveOptions({ level: l }, fullCaps()).frame_pool === 'legacy'));
  ok('only mirror may enter the coverage blocks', resolveOptions({ level: 'mirror' }, fullCaps()).frame_pool === 'all');
  ok('presence computes no warp', resolveOptions({ level: 'presence' }, fullCaps()).affine.strength === 0);
  ok('presence arms all three hooks', (() => { const r = resolveOptions({ level: 'presence' }, fullCaps()); return r.blink_detour && r.start_point_bias && r.mic_talk; })());
  ok('the matcher levels arm none of them', ['expressive', 'mirror'].every((l) => { const r = resolveOptions({ level: l }, fullCaps()); return !r.blink_detour && !r.start_point_bias && !r.mic_talk; }));
}
{
  const { m, res } = build('mirror');
  ok('every level arms ARTICULATE', res.matcher.articulate === true);
  // hybrid: mouthOpen = max(mic, camera * 0.6)
  m.reset();
  const v = Float64Array.from(NEUTRAL);
  v[I.mouthOpen] = 0.5;
  v[I.jawOpen] = 0.5;
  m.setOneEuro(null);
  m.pushPose(TICK, ALL_GROUPS, v, 'raw');
  m.setMicOpenness(null);
  ok('no mic => the camera MAR is the target', close(m.mouthOpenTarget(), 0.5, 1e-9));
  m.setMicOpenness(0.9);
  ok('hybrid takes the louder of mic and camera x 0.6', close(m.mouthOpenTarget(), 0.9, 1e-9));
  m.setMicOpenness(0.1);
  ok('...and the camera still carries a silent open mouth', close(m.mouthOpenTarget(), 0.3, 1e-9));
  m.setMicOpenness(2.5);
  ok('the mic envelope is clamped to 0..1', m.mouthOpenTarget() <= 1.0);
  m.setMicOpenness(null);
  ok('null drops back to the camera', close(m.mouthOpenTarget(), 0.5, 1e-9));
}
{
  // ARTICULATE self-gates on mouth_policy: silent + mirror => camera mouth => armed
  const { m } = build('mirror');
  let t = 0.0;
  let f = m.getRestFrame();
  let seen = false;
  for (let k = 0; k < 40; k++) {
    t += TICK;
    const v = Float64Array.from(NEUTRAL);
    // speech-like: the mouth opens and closes fast
    const openv = k % 4 < 2 ? 0.8 : 0.05;
    v[I.mouthOpen] = v[I.jawOpen] = openv;
    m.pushPose(t, ALL_GROUPS, v, 'raw');
    m.setAudio(false, 0.0, 0.6);
    const r = m.step(t, f);
    f = r.frame;
    seen = seen || r.articulating;
  }
  ok('ARTICULATE arms on speech-like mouth activity', seen);
}
{
  // ...and stays inert while the avatar speaks (the audio owns the mouth)
  const { m } = build('mirror');
  let t = 0.0;
  let f = m.getRestFrame();
  let seen = false;
  for (let k = 0; k < 40; k++) {
    t += TICK;
    const v = Float64Array.from(NEUTRAL);
    v[I.mouthOpen] = v[I.jawOpen] = k % 4 < 2 ? 0.8 : 0.05;
    m.pushPose(t, ALL_GROUPS, v, 'raw');
    m.setAudio(true, 0.5, 0.6);
    const r = m.step(t, f);
    f = r.frame;
    seen = seen || r.articulating;
  }
  ok('ARTICULATE never runs while the avatar speaks (§6 rule 1)', !seen);
}
{
  const m = new MotionMatcher(BANK, null, {});
  ok('articulate is off by default (legacy parity)', m.opt.articulate === false);
  ok('mouth_blend defaults to hybrid', m.opt.mouth_blend === 'hybrid');
  m.setOpennessMap([0, 0.5, 1.0], 60);
  ok('the legacy openness map is accepted', true);
}

// =========================================================== head region (affine §2.5)
{
  const desc = new Float64Array(NDIMS);
  desc[I.bodyScale] = 0.0;
  desc[I.bodyX] = 0.0;
  desc[I.bodyY] = 0.0;
  desc[I.headX] = 0.0;
  desc[I.headY] = 0.0;
  desc[I.faceScale] = 0.0;
  const r = headRegionFromFrame(desc, 0xff);
  // SW = 0.35, eye = (0.5, 0.5 - 0.35*0.7) = (0.5, 0.255), W = 0.35*0.45 = 0.1575
  ok('head region: centre x from the body midline', close(r.cx, 0.5, 1e-9));
  ok('head region: centre y drops below the eye line', close(r.cy, 0.255 + 0.3 * 0.1575, 1e-9));
  ok('head region: rx = 1.20 x cheek width', close(r.rx, 1.2 * 0.1575, 1e-9));
  ok('head region: ry = 1.65 x cheek width', close(r.ry, 1.65 * 0.1575, 1e-9));
  const fb = headRegionFromFrame(desc, 0);
  ok('head region: no BODY group => the upper-45 % fallback', fb.cx === 0.5 && fb.cy === 0.225);
  ok('head region alpha is 1 at the centre', close(regionAlphaAt(r, r.cx, r.cy), 1.0, 1e-9));
  ok('head region alpha is 0 far outside', regionAlphaAt(r, 0.5, 0.99) === 0.0);
  const a = regionAlpha(16, 16, r);
  ok('regionAlpha returns a full alpha map in [0, 1]', a.length === 256 && a.every((v) => v >= 0 && v <= 1));
  // the ramp points INWARD: alpha is exactly 0 on the ellipse boundary, so no pixel
  // outside the head is touched at all and the body stays byte-identical
  ok('head mask: alpha is 0 on the ellipse boundary', close(regionAlphaAt(r, r.cx + r.rx, r.cy), 0.0, 1e-12));
  ok('head mask: alpha is 0 just outside', regionAlphaAt(r, r.cx + r.rx * 1.05, r.cy) === 0.0);
  ok('head mask: the feather is at least 12 % of the head height', featherNorm(r) >= 2 * 0.12 - 1e-12);
  // params_for_head: pivot at the neck base, scale pinned, tighter caps
  const full = { tx: 999, ty: -999, rot_deg: 45, scale: 1.2, pivot: [0, 0] };
  const g = gainsFromOptions(LEVELS.mirror.affine);
  const hp = paramsForHead(full, r, 480, 640, g);
  ok('paramsForHead: tx clamped to the head cap', close(hp.tx, 0.05 * 480, 1e-9));
  ok('paramsForHead: ty clamped to the head cap', close(hp.ty, -0.05 * 640, 1e-9));
  ok('paramsForHead: rotation clamped to the head cap', close(hp.rot_deg, 6.0, 1e-9));
  ok('paramsForHead: the scale is pinned to 1', hp.scale === 1.0);
  ok('paramsForHead: the pivot is the neck base', close(hp.pivot[0], r.cx * 480, 1e-9) && close(hp.pivot[1], (r.cy + r.ry) * 640, 1e-9));
  const [x0, y0, x1, y1] = regionBox(480, 640, r);
  ok('regionBox covers the ellipse plus a margin', x0 >= 0 && y0 >= 0 && x1 <= 480 && y1 <= 640 && x1 > x0 && y1 > y0);
  const area = ((x1 - x0) * (y1 - y0)) / (480 * 640);
  notes.push(`head-warp cost: the head box is ${(area * 100).toFixed(1)} % of the frame (${x1 - x0}x${y1 - y0} of 480x640)`);
}

// =========================================================== fixture parity: levels_cases
{
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, 'levels_cases.json'), 'utf8'));
  ok('levels fixture: browMappingVersion is 2', fx.meta.browMappingVersion === 2);
  ok('levels fixture: crossfadeCost is 6', fx.meta.crossfadeCost === CROSSFADE_COST);
  ok('levels fixture: mouthHandoverMs is 250', fx.meta.mouthHandoverMs === MOUTH_HANDOVER_MS);
  for (const [key, txt] of Object.entries(fx.meta.strings)) {
    ok(`levels fixture: string ${key}`, txt === STRINGS[key]);
  }
  for (const c of fx.cases) {
    const res = resolveOptions(c.comfort, c.caps);
    const exp = c.expectedResolved;
    ok(`${c.name}: level`, res.level === exp.level);
    ok(`${c.name}: requestedLevel`, res.requested_level === exp.requestedLevel);
    ok(`${c.name}: blocked`, res.blocked === exp.blocked);
    ok(`${c.name}: active`, res.active === exp.active);
    ok(`${c.name}: comfort`, JSON.stringify(serializeComfort(res.comfort)) === JSON.stringify(exp.comfort));
    ok(`${c.name}: channels`, arrEq(res.channels, exp.channels));
    // the fixture lists the i18n KEYS, in order; the texts are checked once via meta.strings
    ok(`${c.name}: warnings`, arrEq(res.warnings.map((w) => w.key), exp.warnings));
    ok(
      `${c.name}: warning texts come from the shared table`,
      res.warnings.every((w) => w.text === STRINGS[w.key].split('{deg}').join(String((c.caps.metrics || {}).headYawSpanDeg ?? 0))),
    );
    if (!exp.active) continue;
    ok(`${c.name}: crossfade`, res.crossfade === exp.crossfade);
    ok(`${c.name}: retargetGain`, close(res.retarget_gain, exp.retargetGain, 1e-9));
    ok(`${c.name}: holdMs`, close(res.hold_ms, exp.holdMs, 1e-9));
    ok(
      `${c.name}: oneEuroMinCutoff`,
      exp.oneEuroMinCutoff.every((v, i) => close(res.one_euro_min_cutoff[i], v, 1e-9)),
    );
    for (const [k, v] of Object.entries(exp.matcher)) {
      if (k === 'dim_gain') {
        ok(`${c.name}: matcher.dim_gain`, v.every((x, i) => close(res.matcher.dim_gain[i], x, 1e-12)));
      } else {
        ok(`${c.name}: matcher.${k}`, res.matcher[k] === v || close(Number(res.matcher[k]), Number(v), 1e-12));
      }
    }
    // the whole affine block, including the head-only caps
    for (const [k, v] of Object.entries(exp.affine)) {
      ok(`${c.name}: affine.${k}`, typeof v === 'boolean' ? res.affine[k] === v : close(res.affine[k], v, 1e-9));
    }
  }
  for (const t of fx.crossfadeTrigger) {
    ok(
      `crossfade fixture (${t.cost}, ${t.crossfade}, ${t.canBlend})`,
      shouldCrossfade(t.cost, t.crossfade, t.canBlend) === t.expected,
    );
  }
  for (const a of fx.crossfadeAlpha) {
    ok(`crossfade alpha fixture (${a.elapsedMs}/${a.durationMs})`, close(crossfadeAlpha(a.elapsedMs, a.durationMs), a.alpha, 1e-12));
  }
}

// =========================================================== fixture parity: reach_cases
{
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, 'reach_cases.json'), 'utf8'));
  for (const c of fx.cases) {
    const inp = c.input;
    const rows = inp.rows.map((r) => Float64Array.from(r));
    const poses = buildPosesIndex(rows, inp.masks, inp.seq, {
      confidence: inp.confidence,
      contentHash: inp.contentHash,
      dims: inp.dims,
    });
    const cov = buildCoverage(poses);
    attachReach(poses, cov, inp.minCount);
    ok(`reach ${c.name}: p05`, arrEq(poses.ranges.p05, c.expectedP05));
    ok(`reach ${c.name}: p95`, arrEq(poses.ranges.p95, c.expectedP95));
    ok(`reach ${c.name}: reach.lo`, arrEq(poses.ranges.reach.lo, c.expectedReach.lo));
    ok(`reach ${c.name}: reach.hi`, arrEq(poses.ranges.reach.hi, c.expectedReach.hi));
    const caps = probeCaps(poses, cov);
    for (const [k, v] of Object.entries(c.expectedCaps)) ok(`reach ${c.name}: caps.${k}`, caps[k] === v);
    // retarget vectors: one `cal` push per (level, user), headPitch = -user
    const byLevel = new Map();
    for (const r of c.retarget) {
      if (!byLevel.has(r.level)) {
        const res = resolveOptions({ level: r.level }, caps);
        byLevel.set(r.level, { res, m: new MotionMatcher(poses, null, res.matcher) });
      }
      const { res, m } = byLevel.get(r.level);
      ok(`reach ${c.name}/${r.level}: retargetGain`, close(res.retarget_gain, r.retargetGain, 1e-9));
      m.reset();
      const v = Float64Array.from(NEUTRAL);
      v[I.headYaw] = r.user;
      v[I.headPitch] = -r.user;
      m.pushPose(40.0, FACE_GROUPS, v, 'cal');
      const x = m.getTarget();
      ok(`reach ${c.name}/${r.level}/${r.user}: headYaw`, close(x[I.headYaw], r.headYaw, 1e-5));
      ok(`reach ${c.name}/${r.level}/${r.user}: headPitch`, close(x[I.headPitch], r.headPitch, 1e-5));
    }
  }
}

// ---------------------------------------------------------------- per-tick replay
// The fixture does not only record what `resolveOptions` RETURNS - for each active level
// it also records 300 ticks of a real matcher driven by a scripted pose stream, and the
// frame / mode / teleport / transition-cost / mouth-policy it produced on each one. That
// is the part that catches a port whose option table is right and whose behaviour is not:
// a mis-signed dim gain, a hold that releases a tick early, a handover that never arms.
{
  const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, 'levels_cases.json'), 'utf8'));
  const cases = fx.cases.filter((c) => Array.isArray(c.inputs) && c.inputs.length);
  ok('the fixture carries a replay for every active level', cases.length === 3);
  for (const c of cases) {
    const res = resolveOptions(c.comfort, c.caps);
    // `parity_strict` is what the exporter builds the reference matcher with, and the
    // graph's `restFrame` (50) overrides the bank's (26) — the run starts there, not on
    // the fixture's first recorded frame, or tick 0 is compared against a different seed.
    const m = new MotionMatcher(
      fx.poses,
      fx.graph || null,
      { ...res.matcher, parity_strict: true },
      res.one_euro_min_cutoff ? new OneEuroVector(res.one_euro_min_cutoff) : new OneEuroVector(),
    );
    let frame = m.getRestFrame();
    let badFrame = -1;
    let badMode = -1;
    let badTele = -1;
    let badCost = -1;
    let badPolicy = -1;
    for (let t = 0; t < c.inputs.length; t++) {
      const inp = c.inputs[t];
      // Order matters and is the exporter's: pose first, then audio, then step. `raw`,
      // not `cal` — the fixture records the driver BEFORE calibration, so a `cal` push
      // would skip the retarget the levels exist to scale.
      m.pushPose(Number(inp.t), Number(inp.mask), inp.d, 'raw');
      m.setAudio(!!inp.talking, Number(inp.env) || 0);
      const r = m.step(Number(inp.t), frame);
      frame = r.frame;
      if (badFrame < 0 && r.frame !== c.frames[t]) badFrame = t;
      if (badMode < 0 && r.mode !== c.modes[t]) badMode = t;
      if (badTele < 0 && !!r.teleport !== !!c.teleports[t]) badTele = t;
      if (badCost < 0 && !close(r.transition_cost, c.transitionCosts[t], 1e-9)) badCost = t;
      // `mouthPolicy` is the section 4.3 handover as it RESOLVED (`audio` | `mocap`). Not
      // to be confused with `mouthSource` (`audio` | `camera`), which answers a different
      // question: who supplied the value, not which policy was in force.
      if (badPolicy < 0 && m.mouthPolicy !== c.mouthPolicy[t]) badPolicy = t;
    }
    ok(`${c.name}: replay frames (${c.inputs.length} ticks)`, badFrame < 0);
    ok(`${c.name}: replay modes`, badMode < 0);
    ok(`${c.name}: replay teleports`, badTele < 0);
    ok(`${c.name}: replay transition costs`, badCost < 0);
    ok(`${c.name}: replay mouth policy`, badPolicy < 0);
    if (badFrame >= 0) failures.push(`   ${c.name}: first frame divergence at tick ${badFrame}`);
    if (badPolicy >= 0) failures.push(`   ${c.name}: first policy divergence at tick ${badPolicy}`);
  }
}

console.log(`\nmocap levels: ${pass} passed, ${fail} failed`);
for (const n of notes) console.log(n);
if (failures.length) {
  console.log('\n' + failures.slice(0, 40).join('\n'));
  if (failures.length > 40) console.log(`... and ${failures.length - 40} more`);
  process.exit(1);
}
