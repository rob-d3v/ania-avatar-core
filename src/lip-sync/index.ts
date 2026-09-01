// Barrel for the lip-sync maths. Mirrors `ania-avatar-react`'s
// `src/lip-sync/index.js` so both packages expose the same three names.

export { LipSyncDsp } from './dsp';
export type { LipSyncDspOptions, LipSyncDspReading } from './dsp';
export { LipAnimator, findClosedFrame } from './animator';
export type { LipAnimatorOptions, LipAnimatorStepArgs, LipAnimatorBranch } from './animator';
