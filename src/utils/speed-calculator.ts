// Derive sensible idle/talk animation speeds from an avatar's source fps.
// Ported from the Chrome extension's `lib/utils/speed-calculator.ts`.

export interface OptimalSpeeds {
  idle: number;
  talk: number;
}

/**
 * Compute idle/talk speed multipliers from the avatar fps. Higher fps clips
 * play back faster so they don't look sluggish.
 */
export const calcSpeeds = (fps: number): OptimalSpeeds => {
  if (!fps || fps <= 0) return { idle: 1, talk: 1 };

  const idleSpeed = Math.max(0.5, Math.min(10, fps / 10));
  const talkSpeed = Math.max(1, Math.min(10, fps / 5));

  return {
    idle: parseFloat(idleSpeed.toFixed(1)),
    talk: parseFloat(talkSpeed.toFixed(1)),
  };
};

/** @deprecated Alias of {@link calcSpeeds}, kept for parity with older code. */
export const calculateOptimalSpeeds = calcSpeeds;
