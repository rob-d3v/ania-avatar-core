/**
 * Unit tests for the lip sync DSP (lip-sync/dsp.js).
 *
 * Run: node examples/test-lip-dsp.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 *
 * The point of this file is RATE INDEPENDENCE. The desktop player this is
 * ported from is fed one audio block every 30 ms, so every constant there is
 * per-block. We are polled from requestAnimationFrame: 60 Hz usually, 120 Hz on
 * a high-refresh display, 30 Hz on a loaded machine. If any constant were still
 * per-tick, the avatar would animate differently on different hardware — the
 * worst class of bug, because the reporter's monitor is the hidden variable.
 */
/**
 * Ported verbatim from `ania-avatar-react`'s test of the same name. The maths
 * is the same maths; only the import changes, because here it is TypeScript
 * compiled into `dist/`. Keeping the assertions identical is the point — it is
 * what proves the two packages behave the same.
 *
 * Run: npm run build && node examples/<this file>
 */

import { LipSyncDsp } from '../dist/index.js';

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

// ---- 1. Time constants ----
// Measured as a pure decay from a known start: the only way to read a half-life
// without the input fighting the filter.

// AGC peak: 0.995 per 30 ms -> half-life 30*ln(0.5)/ln(0.995) = 4149 ms.
// Measured on the 1.0 -> 0.5 leg only; below 0.05 the floor stops the decay.
{
  const d = new LipSyncDsp();
  d.peak = 1.0;
  let t = 0;
  while (d.peak > 0.5 && t < 20000) { d.poll(16.667, 0); t += 16.667; }
  near('AGC peak half-life is 4149 ms', t, 4149, 4149 * 0.02);
}

// EMA: retention 0.4 per 30 ms -> half-life 30*ln(0.5)/ln(0.4) = 22.7 ms.
// The gate never opens here, so it never zeroes `smoothed` out from under us.
{
  const d = new LipSyncDsp();
  d.smoothed = 1.0;
  let t = 0;
  // Step finely: the measured crossing can only be as precise as one step, and
  // a 2 ms step would report 24 ms for a true 22.7 ms half-life.
  while (d.smoothed > 0.5 && t < 500) { d.poll(0.1, 0); t += 0.1; }
  near('EMA half-life is 22.7 ms', t, 22.7, 22.7 * 0.05);
}

// ---- 2. Gate hysteresis ----
// Short to open (the mouth must not lag the first syllable), long to close (so
// the gap between TTS chunks does not make the jaw flutter).
{
  const d = new LipSyncDsp();
  let openedAt = null;
  for (let t = 0; t < 600 && openedAt === null; t += 4) {
    if (d.poll(4, 0.09).gateOpen) openedAt = t;
  }
  near('gate opens 60 ms after voice starts', openedAt, 60, 12);

  let closedAt = null;
  for (let t = 0; t < 600 && closedAt === null; t += 4) {
    if (!d.poll(4, 0).gateOpen) closedAt = t;
  }
  near('gate closes 180 ms after voice stops', closedAt, 180, 12);
}

// On the close transition the amplitude trail is collapsed, so the envelope
// downstream returns to rest immediately instead of coasting down the EMA tail.
// Without this the mouth keeps moving ~100 ms after the audio has stopped.
{
  const d = new LipSyncDsp();
  for (let t = 0; t < 400; t += 16.667) d.poll(16.667, 0.09);
  ok('gate is open while voiced', d.isGateOpen());
  let r = null;
  for (let t = 0; t < 400; t += 16.667) { r = d.poll(16.667, 0); if (!r.gateOpen) break; }
  ok('smoothed is zeroed on the close transition', r.smoothed === 0);
  ok('openness is zeroed on the close transition', r.openness === 0);
  ok('amplitude is zeroed on the close transition', r.amplitude === 0);
}

// ---- 3. Rate independence ----
// A smooth input, deliberately: comparing two sample grids across a STEP
// discontinuity is meaningless, because the grids straddle the step on opposite
// sides and what you measure is grid phase, not filter behaviour. Compared by
// linear interpolation for the same reason.
const smoothInput = (t) => 0.045 * (1 - Math.cos((2 * Math.PI * t) / 1200));

const lerpTrace = (trace, t, key) => {
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].t >= t) {
      const a = trace[i - 1];
      const b = trace[i];
      return a[key] + (b[key] - a[key]) * ((t - a.t) / (b.t - a.t));
    }
  }
  return trace[trace.length - 1][key];
};

const runDsp = (dt) => {
  const d = new LipSyncDsp();
  const trace = [];
  for (let t = 0; t < 2400; t += dt) {
    const r = d.poll(dt, smoothInput(t));
    trace.push({ t, smoothed: r.smoothed, peak: r.peak });
  }
  return trace;
};

{
  const at60 = runDsp(16.667);
  const at120 = runDsp(8.333);
  const at30 = runDsp(33.333);

  for (const key of ['smoothed', 'peak']) {
    let worst120 = 0;
    let worst30 = 0;
    for (let t = 200; t < 2300; t += 25) {
      const x = lerpTrace(at60, t, key);
      worst120 = Math.max(worst120, Math.abs(x - lerpTrace(at120, t, key)));
      worst30 = Math.max(worst30, Math.abs(x - lerpTrace(at30, t, key)));
    }
    ok(`${key} agrees between 60 Hz and 120 Hz (worst ${worst120.toFixed(5)})`, worst120 < 0.005);
    ok(`${key} agrees between 60 Hz and 30 Hz (worst ${worst30.toFixed(5)})`, worst30 < 0.005);
  }
}

// The residual must CONVERGE as the tick rate rises. A constant that is still
// per-tick keeps the error flat at a fixed rate ratio; genuine discretisation
// error halves every time the rate doubles. This is the assertion that actually
// distinguishes the two, and it is the reason this file exists.
{
  const worstDiff = (dtA, dtB) => {
    const A = runDsp(dtA);
    const B = runDsp(dtB);
    let w = 0;
    for (let t = 200; t < 2300; t += 25) {
      w = Math.max(w, Math.abs(lerpTrace(A, t, 'smoothed') - lerpTrace(B, t, 'smoothed')));
    }
    return w;
  };
  const coarse = worstDiff(33.333, 16.667);
  const fine = worstDiff(8.333, 4.167);
  ok(
    `discretisation error converges as dt shrinks (${coarse.toFixed(6)} -> ${fine.toFixed(6)})`,
    fine < coarse / 2
  );
}

// ---- 4. Hostile inputs ----
{
  const d = new LipSyncDsp();
  for (let t = 0; t < 600; t += 16.667) d.poll(16.667, 0.09);
  const peakBefore = d.peak;
  // A frozen tab (backgrounded, lid closed, a long synchronous task) hands us a
  // dt of seconds. One such step must not decay the peak to its floor — the
  // next quiet syllable would then normalise to 1.0 and the mouth would slam
  // wide open. The clamp is what prevents that.
  const r = d.poll(5000, 0);
  ok('a 5 s dt is clamped and does not collapse the AGC peak', r.peak > peakBefore * 0.9);
}
{
  const d = new LipSyncDsp();
  const a = d.poll(16.667, NaN);
  const b = d.poll(16.667, undefined);
  const c = d.poll(16.667, -1);
  ok('NaN rms reads as silence, never poisons state', a.smoothed === 0);
  ok('undefined rms reads as silence', Number.isFinite(b.openness));
  ok('negative rms is floored at 0', c.smoothed === 0);
  ok('NaN dt is treated as a zero-length frame', Number.isFinite(d.poll(NaN, 0.09).smoothed));
}

// ---- 5. The optional spectral channel ----
// The desktop's TTS path uses the cheap `amplitude * 1.1` proxy; its mic path
// uses a real FFT. On the web the analyser already exists, so useLipSync can
// hand the richer value through. It must replace the proxy — and the GATE must
// still key off rms, because the 0.020 threshold is in RMS units and means
// nothing on a 0..1 openness curve.
// NOTE the shape of this test: a CONSTANT input cannot distinguish the two
// channels, because the AGC normalises any constant against its own peak and
// both saturate at 1.0. The spectral value has to move independently of the rms
// for the difference to be observable at all.
{
  const withProxy = new LipSyncDsp();
  const withSpectral = new LipSyncDsp();
  let pr = null;
  let sp = null;
  for (let t = 0; t < 900; t += 16.667) {
    // Steady rms (so the proxy channel pins at 1.0) but an openness that halves
    // partway through — a plausible vowel->consonant transition at constant
    // loudness, which is exactly what the proxy cannot see and the FFT can.
    const spectral = t < 450 ? 0.4 : 0.1;
    pr = withProxy.poll(16.667, 0.09);
    sp = withSpectral.poll(16.667, 0.09, spectral);
  }
  ok('spectral openness replaces the amplitude proxy', sp.openness < pr.openness - 0.05);
  ok('the amplitude proxy is blind to that transition', pr.openness === 1);
  ok('gate still keys off rms, not the spectral value', sp.gateOpen === pr.gateOpen && sp.gateOpen);
  ok('spectral openness stays within 0..1', sp.openness >= 0 && sp.openness <= 1);
}

// ---- 6. reset() ----
// Called on the idle->talking edge: state left over from the previous utterance
// (a peak still at 1.0, a gate still counting down) makes the first syllable of
// the next one animate wrong.
{
  const d = new LipSyncDsp();
  for (let t = 0; t < 900; t += 16.667) d.poll(16.667, 0.09);
  d.reset();
  const fresh = new LipSyncDsp();
  const a = d.poll(16.667, 0.05);
  const b = fresh.poll(16.667, 0.05);
  ok('reset() makes the DSP behave like a fresh instance', a.smoothed === b.smoothed && a.peak === b.peak);
}

// ---- Report ----
console.log(`\nlip sync dsp: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
