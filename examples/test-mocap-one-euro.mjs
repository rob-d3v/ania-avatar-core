/**
 * Parity test for the One-Euro filter port (motion-matcher/one-euro.ts) against
 * the fixture generated from the Python reference
 * (`AniaAPP/src/ania_player/plugins/mocap_webcam/one_euro.py`).
 *
 * Run: npm run build && node examples/test-mocap-one-euro.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 *
 * TOLERANCE NOTE: every number in `one_euro_case.json` (t, x, outputs) is
 * serialized rounded to 6 decimal places — confirmed by scanning the raw JSON
 * for the longest decimal fraction across all three parity fixtures, which
 * caps at 6 in every one of them. That is below the fixture spec's nominal
 * "tolerance 1e-9": feeding an already-rounded `t`/`x` through a recursive
 * filter and comparing against an already-rounded `output` cannot beat the
 * ~5e-7 quantization noise the rounding itself introduces (half a unit in the
 * 6th decimal). Measured worst case over all 120 ticks x 48 dims is
 * 4.9766e-7 — i.e. bounded exactly by that quantization, not by a formula
 * error. 6e-7 below is that bound plus headroom, not a loosened check.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OneEuroVector } from '../dist/index.js';

const FIXTURES_DIR =
  process.env.ANIA_MOCAP_FIXTURES ||
  'E:/backup_2026/Repositórios/AnimatedAvatar/AniaAPP/tests/fixtures/mocap';

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'one_euro_case.json'), 'utf8'));

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

const filter = new OneEuroVector();

for (let i = 0; i < fixture.inputs.length; i++) {
  const inp = fixture.inputs[i];
  const expected = fixture.outputs[i];
  const out = filter.filterMasked(inp.t, inp.x, inp.mask);

  let maxDiff = 0;
  let worstDim = -1;
  for (let d = 0; d < expected.length; d++) {
    const diff = Math.abs(out[d] - expected[d]);
    if (diff > maxDiff) {
      maxDiff = diff;
      worstDim = d;
    }
  }
  ok(`tick ${i} (t=${inp.t}): within 6e-7 (max diff ${maxDiff.toExponential(3)} at dim ${worstDim})`, maxDiff <= 6e-7);
}

console.log(`\nmocap one-euro: ${pass} passed, ${fail} failed (${fixture.inputs.length} ticks)`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
