/**
 * Parity test for the PoseDescriptor v1 port (motion-matcher/descriptor.ts)
 * against the fixture generated from the Python reference
 * (`AniaAPP/src/ania_player/plugins/mocap_webcam/descriptor.py`).
 *
 * Run: npm run build && node examples/test-mocap-descriptor.mjs
 *
 * No test framework — tiny assert harness, same as the other examples/test-*
 * files. Exits non-zero on failure.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeDescriptor } from '../dist/index.js';

const FIXTURES_DIR =
  process.env.ANIA_MOCAP_FIXTURES ||
  'E:/backup_2026/Repositórios/AnimatedAvatar/AniaAPP/tests/fixtures/mocap';

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'descriptor_cases.json'), 'utf8'));

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

for (const c of fixture.cases) {
  const label = `${c.name}${c.mirror ? ' (mirror)' : ''}`;
  const [values, mask] = computeDescriptor(c.face ?? null, c.blend ?? null, c.pose ?? null, c.hands ?? null, !!c.mirror);

  ok(`${label}: mask (${mask} vs ${c.mask})`, mask === c.mask);

  let maxDiff = 0;
  let worstDim = -1;
  for (let i = 0; i < c.expected.length; i++) {
    const diff = Math.abs(values[i] - c.expected[i]);
    if (diff > maxDiff) {
      maxDiff = diff;
      worstDim = i;
    }
  }
  ok(`${label}: values within 1e-6 (max diff ${maxDiff.toExponential(3)} at dim ${worstDim})`, maxDiff <= 1e-6);
}

console.log(`\nmocap descriptor: ${pass} passed, ${fail} failed (${fixture.cases.length} cases)`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
