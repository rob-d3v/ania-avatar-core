/**
 * `presence` / "Sutil" — the default reaction level after the 2026-09-05 pivot.
 *
 * Run: npm run build && node examples/test-mocap-sutil.mjs
 *
 * The level no longer picks frames. The legacy `AnimationController` keeps playing its
 * own idle/talk sequences and the camera reaches it through exactly three hooks, ported
 * 1:1 from `AniaAPP/src/ania_player/plugins/mocap_webcam/legacy_drive.py`:
 *
 *   1. TALK       — the user's mic openness drives the SAME lip-sync path the avatar's
 *                   own audio drives. Avatar audio always wins.
 *   2. BLINK      — a 2-tick detour onto an eye-closed frame INSIDE the current sequence,
 *                   handed back at the same position.
 *   3. START HINT — the cycler's own random start position is biased toward the frame
 *                   whose smile and head yaw sit closest to the user's.
 *
 * ACCEPTANCE (the numbers the pivot was specified with)
 *   - `transition_cost_mean` within 10 % of plain legacy playback: Sutil must not make
 *     the motion worse, which is the whole reason frame matching was dropped.
 *   - the avatar is in its TALK range >= 80 % of the ticks while the mic is active.
 *   - blink hit rate >= 0.8: at least 8 blinks in 10 find a frame to detour onto.
 */

import {
  AnimationController,
  MicTalkBridge,
  BlinkDetour,
  SutilDriver,
  SmoothCut,
  resolveOptions,
  BLINK_DETOUR_TICKS,
  BLINK_DETOUR_MAX_DELTA,
  MIC_TALK_THRESHOLD,
  MIC_TALK_CLOSE_TICKS,
  MIC_TALK_OPEN_TICKS,
} from '../dist/index.js';

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

// ------------------------------------------------------------------ 1. the mic bridge
{
  // A stand-in controller: the bridge only ever needs to flip talking and read/replace
  // four getters, which is exactly what the real one exposes.
  const host = {
    talking: false,
    setTalkingState(v) {
      this.talking = v;
    },
    getAmplitudeFn: () => 0.42,
    getRmsFn: () => 0.42,
    getSpectralOpennessFn: () => 0.42,
    getOpennessFn: () => 0.42,
    currentFrameIndex: 0,
    startPointHintFn: null,
  };
  const original = host.getAmplitudeFn;
  const mic = new MicTalkBridge(host);
  mic.attach();
  ok('attach replaces the amplitude getters', host.getAmplitudeFn !== original);
  ok('...but delegates to the original while it does not own the mouth', host.getAmplitudeFn() === 0.42);

  // silence keeps the mouth shut
  for (let i = 0; i < 10; i++) mic.push(0.0, false);
  ok('silence never opens the talk', host.talking === false && mic.owner === false);

  // MIC_TALK_OPEN_TICKS = 1 -> the SECOND loud tick opens it
  mic.push(0.5, false);
  ok('one loud tick is not enough (open_ticks = 1)', mic.owner === false);
  mic.push(0.5, false);
  ok('the second loud tick opens the talk', mic.owner === true && host.talking === true);
  ok('while it owns the mouth the getters report the mic', host.getAmplitudeFn() === 0.5);
  ok('...on every getter the lip-sync path reads', host.getSpectralOpennessFn() === 0.5 && host.getRmsFn() === 0.5);

  // close is slow, so a pause inside a sentence does not drop to idle
  for (let i = 0; i < MIC_TALK_CLOSE_TICKS; i++) mic.push(0.0, false);
  ok('a short pause does not close the talk', mic.owner === true);
  mic.push(0.0, false);
  ok('a long pause closes it', mic.owner === false && host.talking === false);
  ok('...and hands the getters straight back', host.getAmplitudeFn() === 0.42);

  // the avatar's own voice always wins
  mic.push(0.9, false);
  mic.push(0.9, false);
  ok('the mic can take the mouth again', mic.owner === true);
  mic.push(0.9, true);
  ok('avatar audio takes the mouth back immediately', mic.owner === false);
  ok('...and the level is dropped, not left latched', mic.level === 0);
  ok('...without touching setTalkingState (the audio controller owns that flag)', host.talking === true);

  mic.detach();
  ok('detach restores the original getters', host.getAmplitudeFn === original);

  // threshold is the documented one, and NaN/garbage is silence, not a crash
  const m2 = new MicTalkBridge(null);
  ok('the threshold is the spec value', m2.threshold === MIC_TALK_THRESHOLD);
  ok('open ticks is the spec value', m2.openTicks === MIC_TALK_OPEN_TICKS);
  m2.push(NaN, false);
  m2.push(undefined, false);
  m2.push(-5, false);
  ok('garbage envelopes read as silence', m2.level === 0 && m2.owner === false);
  ok('a null host does not throw', true);
}

// ------------------------------------------------------------------ 2. the blink detour
{
  const d = new BlinkDetour();
  ok('the hold is the spec value', d.holdTicks === BLINK_DETOUR_TICKS);
  ok('the reach is the spec value', d.maxDelta === BLINK_DETOUR_MAX_DELTA);

  const pick = (i) => i + 5;
  ok('no edge, no detour', JSON.stringify(d.tick(10, false, pick)) === JSON.stringify([null, null]));

  // BLINK_DETOUR_TICKS = 2: one tick showing the closed frame, one tick handing back
  const t1 = d.tick(10, true, pick);
  ok('the edge forces the eye-closed frame', t1[0] === 15 && t1[1] === null);
  const t2 = d.tick(10, false, pick);
  ok('the detour hands back at the same position', t2[0] === null && t2[1] === 10);
  const t3 = d.tick(10, false, pick);
  ok('and then it is over', t3[0] === null && t3[1] === null);

  // a blink with nowhere to go is counted, not faked
  const d2 = new BlinkDetour();
  const miss = d2.tick(10, true, () => null);
  ok('a blink with no eye-closed frame nearby does nothing', miss[0] === null && miss[1] === null);
  ok('...and is counted as a miss', d2.misses === 1 && d2.detours === 0);

  // a one-tick detour still has to hand back, or the cursor is lost
  const d3 = new BlinkDetour(1);
  const one = d3.tick(7, true, pick);
  ok('a one-tick detour forces and hands back in the same tick', one[0] === 12 && one[1] === 7);

  // an edge arriving mid-detour cannot restart it
  const d4 = new BlinkDetour(4);
  d4.tick(3, true, pick);
  d4.tick(3, true, pick);
  ok('a second edge mid-detour does not stack', d4.detours === 1);
}

// ------------------------------------------------------------------ 3. the driver
{
  // A matcher stand-in with a scripted blink signal and a known bank geometry.
  let blinkAt = new Set();
  let tick = 0;
  const matcher = {
    blinkEdge() {
      return blinkAt.has(tick);
    },
    blinkFrameNear(i, maxDelta) {
      // "the nearest eye-closed frame in the same sequence": every 10th frame here
      const c = Math.round(i / 10) * 10;
      return Math.abs(c - i) <= maxDelta ? c : null;
    },
    startPointScore(candidates) {
      return candidates && candidates.length ? Math.max(...candidates) : null;
    },
  };
  const host = {
    talking: false,
    setTalkingState(v) {
      this.talking = v;
    },
    getAmplitudeFn: null,
    getRmsFn: null,
    getSpectralOpennessFn: null,
    getOpennessFn: null,
    currentFrameIndex: 25,
    startPointHintFn: null,
  };
  const drv = new SutilDriver(host, matcher);
  drv.attach();
  ok('attach installs the start-point hint', typeof host.startPointHintFn === 'function');
  ok('the hint reorders the cycler own options', host.startPointHintFn('idle', [3, 9, 5]) === 9);
  ok('the hint declines an empty option set', host.startPointHintFn('idle', []) === null);

  blinkAt = new Set([2]);
  const forced = [];
  for (tick = 0; tick < 6; tick++) forced.push(drv.onTick(tick * 40, host.currentFrameIndex, 0.0, false));
  ok('the driver stays out of the way on a quiet tick', forced[0] === null && forced[1] === null);
  ok('a blink forces exactly one frame', forced[2] === 30);
  ok('...for BLINK_DETOUR_TICKS - 1 rendered ticks', forced[3] === null);
  ok('...and the cursor is handed back untouched', host.currentFrameIndex === 25);
  ok('the driver reports what it did', drv.stats().blinkDetours === 1 && drv.stats().engine === 'legacy');

  drv.detach();
  ok('detach removes the hint again', host.startPointHintFn === null);

  // a driver with no matcher must be inert, not explosive
  const bare = new SutilDriver(null, null);
  bare.attach();
  ok('a driver with no matcher forces nothing', bare.onTick(0, 0, 0.5, false) === null);
  bare.detach();

  // a matcher that throws must not stop the animation
  const angry = {
    blinkEdge() {
      throw new Error('camera died');
    },
    blinkFrameNear() {
      throw new Error('camera died');
    },
    startPointScore() {
      throw new Error('camera died');
    },
  };
  const drv2 = new SutilDriver(host, angry);
  drv2.attach();
  ok('a throwing matcher is swallowed on tick', drv2.onTick(0, 5, 0.5, false) === null);
  ok('a throwing matcher is swallowed on the hint', host.startPointHintFn('idle', [1, 2]) === null);
  drv2.detach();
}

// ------------------------------------------------------------------ 4. the level table
{
  const caps = {
    face: 1,
    head: 1,
    blink: 1,
    mouth: 1,
    smile: 1,
    gaze: 1,
    brows: 1,
    hands: 1,
    mouthShapes: 1,
    blend: 1,
    metrics: { headYawSpanDeg: 30 },
  };
  const r = resolveOptions({ level: 'presence' }, caps);
  ok('presence runs the legacy engine', r.engine === 'legacy');
  ok('presence stays in the legacy frame pool', r.frame_pool === 'legacy');
  ok('presence never teleports', r.matcher.allow_teleport === false);
  ok('presence never warps', r.affine.strength === 0 && r.affine_enabled === false);
  ok('presence does not crossfade', r.comfort.crossfade === 'off');
  ok('presence leaves ARTICULATE to the openness map', r.matcher.articulate === false);
  ok('presence wants the mic', r.needs_mic === true && r.mic_talk === true);
  ok('presence arms the blink detour', r.blink_detour === true);
  ok('presence arms the start-point bias', r.start_point_bias === true);
  ok('presence never gives the matcher the mouth', r.matcher.mouth_policy === 'audio');

  const m = resolveOptions({ level: 'mirror' }, caps);
  ok('mirror runs the matcher', m.engine === 'matcher');
  ok('mirror is the only level allowed into the coverage blocks', m.frame_pool === 'all');
  ok('mirror arms none of the legacy hooks', !m.blink_detour && !m.start_point_bias && !m.mic_talk);
}

// ------------------------------------------------------------------ 5. acceptance run
/**
 * A scripted session against a synthetic bank, measuring the three numbers the pivot was
 * specified with. The playback is the same shape as `test-smooth-cut.mjs`: an idle range,
 * a talk range and a coverage block that must never be shown.
 */
{
  const N = 100;
  const IDLE_LOW = 0;
  const IDLE_HIGH = 39;
  const TALK_LOW = 40;
  const TALK_HIGH = 79;

  // ---- legacy baseline: the mic drives the talk exactly as an avatar's audio would
  function session({ useSutil, ticks = 800 }) {
    const host = {
      talking: false,
      frame: IDLE_LOW,
      dir: 1,
      setTalkingState(v) {
        if (this.talking === v) return;
        this.talking = v;
        this.frame = v ? TALK_LOW : IDLE_LOW;
      },
      getAmplitudeFn: null,
      getRmsFn: null,
      getSpectralOpennessFn: null,
      getOpennessFn: null,
      currentFrameIndex: IDLE_LOW,
      startPointHintFn: null,
    };
    // Blink frames every 10 within each range, which is what `blinkFrameNear` looks for.
    const isBlink = (j) => j % 10 === 0;
    let now = 0;
    let blinkNow = false;
    const matcher = {
      blinkEdge: () => blinkNow,
      blinkFrameNear(i, maxDelta) {
        let best = null;
        const lo = host.talking ? TALK_LOW : IDLE_LOW;
        const hi = host.talking ? TALK_HIGH : IDLE_HIGH;
        for (let j = Math.max(lo, i - maxDelta); j <= Math.min(hi, i + maxDelta); j++) {
          if (!isBlink(j)) continue;
          if (best === null || Math.abs(j - i) < Math.abs(best - i)) best = j;
        }
        return best;
      },
      startPointScore: (c) => (c && c.length ? c[0] : null),
    };
    // The BASELINE is not "no camera at all" — that avatar never talks, and comparing it
    // to a talking one measures the talk, not Sutil. It is the same session with the same
    // mic-driven talk switching and the two frame-touching hooks disarmed, so the only
    // difference measured is what the blink detour and the start-point bias cost.
    const drv = new SutilDriver(host, matcher, {
      blinkDetour: useSutil,
      startPointBias: useSutil,
    });
    drv.attach();

    const frames = [];
    let talkTicks = 0;
    let micTicks = 0;
    let blinkAttempts = 0;
    let blinkHits = 0;

    for (let k = 0; k < ticks; k++) {
      now += 40;
      // the user speaks in 30-tick bursts every 60 ticks
      const speaking = k % 60 < 30;
      const openness = speaking ? 0.4 : 0.0;
      // the user blinks every 47 ticks
      blinkNow = k % 47 === 0 && k > 0;
      if (blinkNow) blinkAttempts += 1;

      const before = drv.detour.detours;
      const forced = drv.onTick(now, host.currentFrameIndex, openness, false);
      if (blinkNow && drv.detour.detours > before) blinkHits += 1;
      if (openness > 0) micTicks += 1;

      if (forced !== null) {
        frames.push(forced);
        continue;
      }
      // one tick of the legacy cycler
      const lo = host.talking ? TALK_LOW : IDLE_LOW;
      const hi = host.talking ? TALK_HIGH : IDLE_HIGH;
      host.currentFrameIndex += 1;
      if (host.currentFrameIndex > hi || host.currentFrameIndex < lo) host.currentFrameIndex = lo;
      frames.push(host.currentFrameIndex);
      if (host.currentFrameIndex >= TALK_LOW && host.currentFrameIndex <= TALK_HIGH && openness > 0) {
        talkTicks += 1;
      }
    }
    drv.detach();
    return { frames, talkTicks, micTicks, blinkAttempts, blinkHits };
  }

  const base = session({ useSutil: false });
  const sutil = session({ useSutil: true });

  // The scorer needs a graph shaped like a real one, or the measurement contradicts the
  // design. `graph.py` emits an edge between any two frames that look alike, and the
  // whole argument for the blink detour is that frames a few apart inside ONE sequence
  // differ by a blink and little else. So: cheap edges between near neighbours of the
  // same range, priced by distance. Cutting across the ranges stays a full `c_jump`.
  const near = { offsets: [0], to: [], cost: [], frameCount: N };
  for (let i = 0; i < N; i++) {
    const lo = i <= IDLE_HIGH ? IDLE_LOW : TALK_LOW;
    const hi = i <= IDLE_HIGH ? IDLE_HIGH : TALK_HIGH;
    for (let j = Math.max(lo, i - 30); j <= Math.min(hi, i + 30); j++) {
      if (j === i) continue;
      near.to.push(j);
      near.cost.push(0.1 * Math.abs(j - i));
    }
    near.offsets.push(near.to.length);
  }
  const sc = new SmoothCut(near, { enabled: true });
  const mean = (frames) => {
    let sum = 0;
    let count = 0;
    for (let i = 1; i < frames.length; i++) {
      if (frames[i] === frames[i - 1]) continue;
      sum += sc.cost(frames[i - 1], frames[i]);
      count += 1;
    }
    return count ? sum / count : 0;
  };
  const baseMean = mean(base.frames);
  const sutilMean = mean(sutil.frames);

  ok(
    `transition_cost_mean within 10 % of legacy (${baseMean.toFixed(3)} -> ${sutilMean.toFixed(3)})`,
    Math.abs(sutilMean - baseMean) <= Math.max(0.01, baseMean * 0.1),
  );

  const talkPct = sutil.micTicks ? (100 * sutil.talkTicks) / sutil.micTicks : 0;
  ok(`talk range >= 80 % of the ticks while the mic is active (${talkPct.toFixed(1)} %)`, talkPct >= 80);

  const hitRate = sutil.blinkAttempts ? sutil.blinkHits / sutil.blinkAttempts : 0;
  ok(`blink hit rate >= 0.8 (${hitRate.toFixed(2)})`, hitRate >= 0.8);
  ok('both sessions switch to talk the same way', base.talkTicks > 0 && sutil.talkTicks > 0);
  ok('the baseline takes no detours', base.blinkHits === 0);

  console.log(
    `\nsutil acceptance: transition_cost_mean legacy ${baseMean.toFixed(3)} -> sutil ${sutilMean.toFixed(3)}; ` +
      `talk ${talkPct.toFixed(1)} % of mic-active ticks; blink hits ${sutil.blinkHits}/${sutil.blinkAttempts}`,
  );
}

// ------------------------------------------------------------------ 6. the engine gate
// The Sutil branch is gated on the DRIVER existing, never on the reported engine string.
// `resolveOptions` says `engine: "legacy"` for level `off` as well, so a constant gate
// swallows the matcher for the pre-levels call shape — `configureMocap({poses, options})`
// plus `setMocapEnabled(true)`, which is every host deployed before the levels landed.
// The matcher would be built and then never stepped, silently.
{
  const N = 8;
  const D = 64;
  const poses = {
    descriptorVersion: 1,
    dims: D,
    frameCount: N,
    data: new Array(N * D).fill(0).map((_, k) => (k % D) / D),
    mask: new Array(N).fill(0xff),
    neutral: new Array(D).fill(0),
    seq: [
      { name: 'idle', low: 0, high: 3 },
      { name: 'talk', low: 4, high: 7 },
    ],
  };
  const cfg = () => ({
    idle_range_low: 0,
    idle_range_high: 3,
    talk_range_low: 4,
    talk_range_high: 7,
    ania_fps_clamp: false,
  });

  const ac = new AnimationController(cfg(), N);
  ok('the pre-levels call shape is still accepted', ac.configureMocap({ poses }) === true);
  ac.setMocapEnabled(true);
  ac.pushPose({ v: 1, t: 1000, mask: 0xff, d: new Array(D).fill(0.5) });
  for (let k = 1; k < 8; k++) ac.getNextFrame(1000 + k * 40);
  ok('...and the matcher actually drives the frame', ac.isMocapActive() === true);
  ok('...reaching LIVE, not sitting unstepped', ac.getMocapMode() === 'LIVE');

  // and with no pose pushed at all it must stay out of the way
  const idle = new AnimationController(cfg(), N);
  idle.configureMocap({ poses });
  idle.setMocapEnabled(true);
  idle.getNextFrame(40);
  ok('a matcher with no fresh pose does not claim the frame', idle.isMocapActive() === false);
}

for (const f of failures) console.log(f);
console.log(`\nmocap sutil: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
