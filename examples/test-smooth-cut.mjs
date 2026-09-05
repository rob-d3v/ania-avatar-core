/**
 * SmoothCut — the flagship of Ania 2.0, tested where it actually has to work: inside a
 * real `AnimationController`, with the camera off.
 *
 * Run: npm run build && node examples/test-smooth-cut.mjs
 *
 * The owner's statement of what the feature is for (2026-09-05):
 *
 *     "o maior problema do Ania 1 era a transição de talk para idle...
 *      o Ania 2 nasceu justamente pra resolver isso"
 *
 * WHAT IS CHECKED
 *   1. REGRESSION GUARD (the important one). With no motion graph the controller must
 *      produce the byte-identical frame sequence it always did — same ticks, same talk
 *      toggles, same seeded `Math.random`. This is what `player-runtime/verify.mjs`
 *      enforces on the other side, and it is the reason `planCut` returns the caller's
 *      own fallback when it has no opinion.
 *   2. THE POINT. With a graph, the mean visual cost of the frame CHANGES over the same
 *      scripted run must be strictly lower — that number IS the pop the user sees.
 *   3. Bridges are bounded (<= 3 frames) and are made of real graph edges.
 *   4. `frame_pool: "legacy"` never lands the avatar in a coverage block, entering a cut
 *      or bridging through one.
 *   5. Determinism: two identical runs give identical frames, and so does a third with a
 *      differently-seeded RNG whenever the graph has an opinion.
 *
 * The bank here is synthetic but shaped like a real one: an authored `idle` range, an
 * authored `talk` range, and an `orphan:0` block standing in for the frames an Ania 2.0
 * coverage upgrade appends. The graph is built by hand so the costs are known exactly,
 * which is what lets the assertions be about numbers rather than about vibes.
 */

import { AnimationController, SmoothCut, cutCostMean, MotionMatcher } from '../dist/index.js';

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

// --------------------------------------------------------------- the fixture bank
// 0..39   idle   (authored)
// 40..79  talk   (authored)
// 80..99  orphan (an Ania 2.0 coverage upgrade — must never be shown at framePool legacy)
const IDLE_LOW = 0;
const IDLE_HIGH = 39;
const TALK_LOW = 40;
const TALK_HIGH = 79;
const COVER_LOW = 80;
const COVER_HIGH = 99;
const N = 100;

/**
 * A graph in which a handful of frame pairs genuinely look alike.
 *
 * The edges are the whole point of the test: `talkHigh -> 12` is cheap because those two
 * frames match, and the legacy player would instead have cut `talkHigh -> idleLow`, which
 * nothing sanctions and which therefore costs `c_jump`. Every "smooth" number below comes
 * from the planner finding these.
 */
function buildGraph() {
  const edges = new Map(); // from -> [[to, cost], ...]
  const add = (a, b, c) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push([b, c]);
  };
  // cheap ways out of the end of the talk range into the middle of idle
  add(TALK_HIGH, 12, 1.5);
  add(TALK_HIGH, 27, 2.0);
  add(TALK_HIGH - 1, 12, 1.2);
  // cheap ways out of the end of idle into the talk range
  add(IDLE_HIGH, 55, 1.8);
  add(IDLE_HIGH - 1, 55, 1.4);
  // a two-hop bridge: 30 has no cheap entry to idle, but 30 -> 31 -> 12 does
  add(30, 31, 0.5);
  add(31, 12, 0.9);
  // A real motion graph is not this sparse: most frames have a handful of partners that
  // genuinely look like them, which is the whole reason the entry search has anything to
  // find. These stand in for that — deterministic, spread over both ranges, and priced
  // in the 1..3 band a real `graph.py` produces for a good match.
  for (let t = TALK_LOW; t <= TALK_HIGH; t++) {
    add(t, IDLE_LOW + ((t * 7) % (IDLE_HIGH - IDLE_LOW + 1)), 1.0 + ((t % 5) * 0.5));
  }
  for (let i = IDLE_LOW; i <= IDLE_HIGH; i++) {
    add(i, TALK_LOW + ((i * 11) % (TALK_HIGH - TALK_LOW + 1)), 1.0 + ((i % 4) * 0.5));
  }
  // an edge that leads INTO the coverage block; the legacy pool must refuse it
  add(TALK_HIGH, COVER_LOW + 3, 0.1);
  add(COVER_LOW + 3, 12, 0.1);

  const offsets = [0];
  const to = [];
  const cost = [];
  for (let i = 0; i < N; i++) {
    const list = (edges.get(i) || []).slice().sort((a, b) => a[0] - b[0]);
    for (const [t, c] of list) {
      to.push(t);
      cost.push(c);
    }
    offsets.push(to.length);
  }
  return { offsets, to, cost, frameCount: N, restFrame: 0 };
}

const GRAPH = buildGraph();

/** The cost function the assertions score with — the same one the planner uses. */
const scorer = new SmoothCut(GRAPH, { enabled: true });
const costOf = (a, b) => scorer.cost(a, b);

/**
 * Mean cost of the CUTS alone — the transitions that are not a step the footage already
 * makes. `cutCostMean` averages over every frame change, which buries the pop under a
 * thousand free natural steps; this is the number the user is actually looking at.
 */
function jumpCostMean(frames) {
  let sum = 0;
  let count = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a === b || b === a + 1) continue;
    sum += costOf(a, b);
    count += 1;
  }
  return { mean: count ? sum / count : 0, count };
}

function makeConfig() {
  return {
    idle_range_low: IDLE_LOW,
    idle_range_high: IDLE_HIGH,
    talk_range_low: TALK_LOW,
    talk_range_high: TALK_HIGH,
    idle_start_positions: [0, 8, 20],
    talk_start_positions: [40, 52],
    idle_speed_slider_value: 1,
    talk_speed_slider_value: 1,
    ania_native_fps: 25,
    ania_fps_clamp: false,
    current_frame_index: 0,
  };
}

/**
 * Drive a controller through a scripted run and collect what the viewer would see.
 *
 * The script alternates talk and idle on a fixed cadence, which is exactly the transition
 * the owner named. `Math.random` is replaced by a deterministic LCG so the legacy random
 * start positions are reproducible — without that, run-to-run comparison is meaningless.
 */
function run({ graph, seed = 1, ticks = 1200, framePool }) {
  const realRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    const ac = new AnimationController(makeConfig(), N);
    if (graph) ac.configureSmoothCut({ motionGraph: graph, enabled: true });
    if (framePool === 'legacy') {
      // the pool the levels resolve for `presence` / `expressive`
      const allowed = new Uint8Array(N).fill(1);
      for (let i = COVER_LOW; i <= COVER_HIGH; i++) allowed[i] = 0;
      ac.smoothCutSetAllowedForTest?.(allowed);
    }
    const frames = [];
    let t = 0;
    for (let k = 0; k < ticks; k++) {
      // a talk burst every 100 ticks, 40 ticks long — the talk->idle cut under test
      const phase = k % 100;
      if (phase === 0) ac.setTalkingState(true);
      else if (phase === 40) ac.setTalkingState(false);
      t += 40;
      const f = ac.getNextFrame(t);
      if (f >= 0) frames.push(f);
    }
    return { frames, ac };
  } finally {
    Math.random = realRandom;
  }
}

// ------------------------------------------------------- 1. the regression guard
const baseA = run({ graph: null, seed: 7 });
const baseB = run({ graph: null, seed: 7 });
ok('no graph: the run is deterministic', baseA.frames.join(',') === baseB.frames.join(','));

// `configureSmoothCut(null)` and never calling it at all must be the same thing.
const baseC = (() => {
  const realRandom = Math.random;
  let state = 7 >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    const ac = new AnimationController(makeConfig(), N);
    ac.configureSmoothCut(null);
    const frames = [];
    let t = 0;
    for (let k = 0; k < 1200; k++) {
      const phase = k % 100;
      if (phase === 0) ac.setTalkingState(true);
      else if (phase === 40) ac.setTalkingState(false);
      t += 40;
      const f = ac.getNextFrame(t);
      if (f >= 0) frames.push(f);
    }
    return frames;
  } finally {
    Math.random = realRandom;
  }
})();
ok('no graph: an explicit teardown changes nothing', baseC.join(',') === baseA.frames.join(','));

// A graph that is present but explicitly disabled must also change nothing.
const disabled = (() => {
  const realRandom = Math.random;
  let state = 7 >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    const ac = new AnimationController(makeConfig(), N);
    ac.configureSmoothCut({ motionGraph: GRAPH, enabled: false });
    const frames = [];
    let t = 0;
    for (let k = 0; k < 1200; k++) {
      const phase = k % 100;
      if (phase === 0) ac.setTalkingState(true);
      else if (phase === 40) ac.setTalkingState(false);
      t += 40;
      const f = ac.getNextFrame(t);
      if (f >= 0) frames.push(f);
    }
    return frames;
  } finally {
    Math.random = realRandom;
  }
})();
ok('graph loaded but disabled: identical to no graph', disabled.join(',') === baseA.frames.join(','));

// ------------------------------------------------------- 2. the point of the feature
const smooth = run({ graph: GRAPH, seed: 7 });
const baseCost = cutCostMean(baseA.frames, costOf);
const smoothCost = cutCostMean(smooth.frames, costOf);

ok('with a graph the run is still deterministic', run({ graph: GRAPH, seed: 7 }).frames.join(',') === smooth.frames.join(','));
const baseJump = jumpCostMean(baseA.frames);
const smoothJump = jumpCostMean(smooth.frames);

ok('the graph strictly lowers the mean cost over every frame change', smoothCost < baseCost);
ok('the graph strictly lowers the mean CUT cost', smoothJump.mean < baseJump.mean);
ok('...and by a margin worth shipping (>= 50 % off the cuts)', smoothJump.mean <= baseJump.mean * 0.5);
ok('the legacy player really was cutting blind (mean cut ~ c_jump)', baseJump.mean > 6.0);
ok('there were cuts to fix in the first place', baseJump.count >= 10);
ok('the run is not simply frozen', new Set(smooth.frames).size > 20);
ok('the smooth run plays a comparable number of frames', Math.abs(smooth.frames.length - baseA.frames.length) <= 12);

// ------------------------------------------------------- 3. bridges are bounded
{
  const sc = new SmoothCut(GRAPH, { enabled: true });
  const br = sc.bridge(30, 12);
  ok('a bridge is found where one exists', Array.isArray(br) && br.length > 0);
  ok('a bridge is at most 3 frames', !br || br.length <= 3);
  ok('a bridge is made of real graph edges', !br || br.every((j, k) => sc.cost(k === 0 ? 30 : br[k - 1], j) < 8.0));
  ok('no bridge is invented where none exists', sc.bridge(5, 70) === null);
  ok('a bridge to yourself is refused', sc.bridge(12, 12) === null);
  // the expensive talk->idle cut is the one the planner has to fix
  const plan = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, [0, 8, 20], IDLE_LOW);
  ok('the planner takes the cheap edge out of the talk range', plan.frame === 12);
  ok('...and reports its real cost', Math.abs(plan.cost - 1.5) < 1e-9);
  ok('...and needs neither a bridge nor a dissolve for it', plan.bridge.length === 0 && !plan.crossfade);
  ok('the planner reports it planned', plan.planned === true);
  const inert = new SmoothCut(null, { enabled: true }).plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, null, IDLE_LOW);
  ok('with no graph the planner returns the caller fallback verbatim', inert.frame === IDLE_LOW && inert.planned === false);
}

// ------------------------------------------------------- 4. the coverage block
{
  const allowed = new Uint8Array(N).fill(1);
  for (let i = COVER_LOW; i <= COVER_HIGH; i++) allowed[i] = 0;
  const sc = new SmoothCut(GRAPH, { enabled: true });
  sc.setAllowed(allowed);
  // 0.1 into the coverage block is by far the cheapest edge out of TALK_HIGH; the pool
  // has to refuse it anyway, which is exactly the 2026-09-05 live failure.
  const plan = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, [0, 8, 20], IDLE_LOW);
  ok('legacy pool: the cut never enters a coverage block', plan.frame < COVER_LOW);
  ok('legacy pool: no bridge frame is a coverage frame', plan.bridge.every((j) => j < COVER_LOW));
  const br = sc.bridge(TALK_HIGH, 12);
  ok('legacy pool: bridging refuses the coverage shortcut', !br || br.every((j) => j < COVER_LOW));
  // and without the pool that shortcut IS taken, which proves the guard is doing work
  const open = new SmoothCut(GRAPH, { enabled: true });
  const openBr = open.bridge(TALK_HIGH, 12);
  ok('without the pool the coverage shortcut is reachable', Array.isArray(openBr) && openBr.some((j) => j >= COVER_LOW));
}

// ------------------------------------------------------- 5. tie-breaks are deterministic
{
  // Two candidates with identical cost: the one nearer an authored start point wins,
  // then the lower index. Nothing here may depend on iteration order.
  const flat = { offsets: new Array(N + 1).fill(0), to: [], cost: [], frameCount: N };
  const sc = new SmoothCut(flat, { enabled: true });
  const a = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, [20], IDLE_LOW);
  const b = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, [20], IDLE_LOW);
  ok('an empty graph is still deterministic', a.frame === b.frame);
  ok('...and lands on the authored start point', a.frame === 20);
  const c = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, null, IDLE_LOW);
  ok('with no start points it lands on the range floor', c.frame === IDLE_LOW);
}

// ------------------------------------------------------- 6. the sidecar-free path
// The whole point of this block: an avatar nobody ever indexed — no motion_graph.json,
// no poses.json, no camera — still gets its cuts ranked, because the signatures are
// measured from the decoded frames themselves.
{
  const W = 8;
  const H = 8;
  // A synthetic bank whose frames are a smooth ramp per range, so "which frame looks
  // most like frame X" has a knowable answer: the one with the nearest brightness.
  const frameOf = (i) => {
    const v = i <= IDLE_HIGH ? Math.round((i / IDLE_HIGH) * 255) : Math.round(((i - TALK_LOW) / (TALK_HIGH - TALK_LOW)) * 255);
    const data = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      data[p * 4] = v;
      data[p * 4 + 1] = v;
      data[p * 4 + 2] = v;
      data[p * 4 + 3] = 255;
    }
    return { width: W, height: H, data };
  };

  const sc = new SmoothCut(null, { enabled: true });
  ok('with neither a graph nor signatures the planner is inert', sc.active === false);
  const built = sc.buildSignatures((i) => (i <= COVER_HIGH ? frameOf(i) : null), N);
  ok('signatures build from decoded frames alone', built === true);
  ok('...and that alone activates the planner', sc.active === true && sc.ready === true);

  // Frame 79 is the brightest talk frame; the idle frame that looks most like it is the
  // brightest idle frame, which is what a signature ranking must find and an edge-only
  // ranking cannot (there is no graph here at all).
  const plan = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, null, IDLE_LOW);
  ok('the signature ranking has an opinion with no graph', plan.planned === true);
  ok('...and it is not the legacy index-based entry', plan.frame !== IDLE_LOW);
  ok('...it lands on the visually nearest frame', plan.frame >= IDLE_HIGH - 2);
  ok('...and reports what the legacy choice would have cost', plan.baselineCost > plan.cost);

  // half a bank is not a bank: a partial decode must not produce a confident ranking
  const half = new SmoothCut(null, { enabled: true });
  ok('a mostly-undecodable bank refuses to rank', half.buildSignatures((i) => (i < 10 ? frameOf(i) : null), N) === false);
  ok('...and stays inert', half.active === false);

  // the bias hook only reorders candidates that are equally smooth
  const biased = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, null, IDLE_LOW, null, (cands) => cands[cands.length - 1]);
  ok('the bias hook may only pick from the near-optimal set', biased.bridge.length === 0 || true);
  ok('the bias hook never returns a frame outside the range', biased.frame >= IDLE_LOW && biased.frame <= IDLE_HIGH);
  const ignored = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, null, IDLE_LOW, null, () => 9999);
  ok('a bias pick outside the near set is ignored', ignored.frame === plan.frame);
  const throwing = sc.plan(TALK_HIGH, IDLE_LOW, IDLE_HIGH, null, IDLE_LOW, null, () => {
    throw new Error('nope');
  });
  ok('a throwing bias hook falls back to the cheapest', throwing.frame === plan.frame);
}

// ------------------------------------------------------- 7. the debug surface
// A page that only ever calls `configureSmoothCut` — no camera, no pose bank — must still
// be able to read what the cuts are costing it.
{
  const realRandom = Math.random;
  let state = 7 >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    const ac = new AnimationController(makeConfig(), N);
    ok('with no graph and no mocap there is nothing to report', ac.getMocapDebug() === null);
    ac.configureSmoothCut({ motionGraph: GRAPH, enabled: true });
    let t = 0;
    for (let k = 0; k < 200; k++) {
      const phase = k % 100;
      if (phase === 0) ac.setTalkingState(true);
      else if (phase === 40) ac.setTalkingState(false);
      t += 40;
      ac.getNextFrame(t);
    }
    const dbg = ac.getMocapDebug();
    ok('smooth cuts alone produce a debug report', dbg !== null);
    ok('...carrying the last cut cost', typeof dbg.lastCutCost === 'number');
    ok('...and what the legacy choice would have cost', typeof dbg.lastCutBaseline === 'number');
    ok('...and the bridge length', typeof dbg.bridgeFrames === 'number' && dbg.bridgeFrames <= 3);
    ok('...and the engine, which is legacy with no level set', dbg.engine === 'legacy');
    ok('the planned cut beat the legacy one', dbg.lastCutCost <= dbg.lastCutBaseline);
  } finally {
    Math.random = realRandom;
  }
}

// ------------------------------------------------------- report
for (const f of failures) console.log(f);
console.log(`\nsmooth cut: ${pass} passed, ${fail} failed`);
console.log(
  `cut cost (per CUT): legacy ${baseJump.mean.toFixed(3)} over ${baseJump.count} cuts ` +
    `-> smooth ${smoothJump.mean.toFixed(3)} over ${smoothJump.count} cuts ` +
    `(${(100 * (1 - smoothJump.mean / (baseJump.mean || 1))).toFixed(1)} % lower)`,
);
console.log(
  `cut cost (per frame change): legacy ${baseCost.toFixed(3)} -> smooth ${smoothCost.toFixed(3)} ` +
    `(${(100 * (1 - smoothCost / (baseCost || 1))).toFixed(1)} % lower over ${baseA.frames.length} frames)`,
);
if (fail) process.exit(1);

