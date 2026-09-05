/**
 * One-Euro filter (Casiez et al., CHI 2012), vectorised over a descriptor.
 *
 * 1:1 port of `AniaAPP/src/ania_player/plugins/mocap_webcam/one_euro.py`.
 *
 * Per-group tuning (min_cutoff Hz, beta): HEAD 1.0/0.3, MOUTH 2.5/1.0, EYES 3.0/1.0
 * (blinks are fast), BROWS 1.5/0.5, BODY 0.8/0.2, HANDS 1.2/0.5, d_cutoff 1.0
 * everywhere. Dims absent from the live mask are not updated (their state is
 * frozen), so a hand that reappears does not "slide in" from a stale value.
 */

import { DIM_GROUP, G_HEAD, G_MOUTH, G_EYES, G_BROWS, G_BODY, G_HAND_L, G_HAND_R, G_RESERVED, NDIMS, groupVector } from './descriptor';

export const GROUP_PARAMS: Record<number, [number, number]> = {
  [G_HEAD]: [1.0, 0.3],
  [G_MOUTH]: [2.5, 1.0],
  [G_EYES]: [3.0, 1.0],
  [G_BROWS]: [1.5, 0.5],
  [G_BODY]: [0.8, 0.2],
  [G_HAND_L]: [1.2, 0.5],
  [G_HAND_R]: [1.2, 0.5],
  [G_RESERVED]: [1.0, 0.0],
};
export const MIN_DT_MS = 10.0;
export const MAX_DT_MS = 200.0;

const alpha = (rate: number, cutoff: number): number => 1.0 / (1.0 + rate / (2.0 * Math.PI * cutoff));

export class OneEuroVector {
  public readonly minCutoff: Float64Array;
  public readonly beta: Float64Array;
  public readonly dCutoff: number;
  public readonly n: number;

  private xHat!: Float64Array;
  private dxHat!: Float64Array;
  private initialised!: Uint8Array;
  private tPrev: number | null = null;

  constructor(minCutoff?: ArrayLike<number>, beta?: ArrayLike<number>, dCutoff = 1.0, n: number = NDIMS) {
    this.n = n;
    this.minCutoff = minCutoff
      ? Float64Array.from(minCutoff)
      : Float64Array.from({ length: n }, (_, i) => GROUP_PARAMS[DIM_GROUP[i]][0]);
    this.beta = beta
      ? Float64Array.from(beta)
      : Float64Array.from({ length: n }, (_, i) => GROUP_PARAMS[DIM_GROUP[i]][1]);
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset(): void {
    this.xHat = new Float64Array(this.n);
    this.dxHat = new Float64Array(this.n);
    this.initialised = new Uint8Array(this.n);
    this.tPrev = null;
  }

  /** Filter sample `x` at time `tMs`. `active` = per-dim 0/1 (or null/undefined = all). */
  filter(tMs: number, x: ArrayLike<number>, active?: ArrayLike<number> | null): Float64Array {
    let te: number;
    if (this.tPrev === null) {
      te = MIN_DT_MS;
    } else {
      te = Math.min(MAX_DT_MS, Math.max(MIN_DT_MS, tMs - this.tPrev));
    }
    this.tPrev = tMs;
    const rate = 1000.0 / te;
    const aD = alpha(rate, this.dCutoff);

    for (let i = 0; i < this.n; i++) {
      const act = active ? active[i] > 0.5 : true;
      if (!act) continue;
      const xi = x[i];
      if (!this.initialised[i]) {
        this.xHat[i] = xi;
        this.dxHat[i] = 0.0;
        this.initialised[i] = 1;
        continue;
      }
      const dx = (xi - this.xHat[i]) * rate;
      this.dxHat[i] = this.dxHat[i] + aD * (dx - this.dxHat[i]);
      const cutoff = this.minCutoff[i] + this.beta[i] * Math.abs(this.dxHat[i]);
      const a = alpha(rate, cutoff);
      this.xHat[i] = this.xHat[i] + a * (xi - this.xHat[i]);
    }
    return this.xHat.slice();
  }

  filterMasked(tMs: number, x: ArrayLike<number>, mask: number): Float64Array {
    return this.filter(tMs, x, groupVector(mask).subarray(0, this.n));
  }
}
