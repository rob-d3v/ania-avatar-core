/**
 * Residual 2-D affine warp — the "head move X/Y" trick applied to a frame bank.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/affine.py`.
 *
 * The matcher picks the nearest frame; the residual between the live descriptor and
 * that frame's descriptor (yaw, pitch, roll, body offset) is turned into a small
 * rotation / translation / scale of the frame. Even a bank with 3 head bins then
 * follows the user continuously instead of snapping.
 *
 * Gains are deliberately modest and clamped: this is a *residual*, not a puppet.
 * Pure module — no canvas, no DOM. {@link paramsFromResidual} produces the numbers;
 * the renderer applies them (see `AniaPlayer.renderFrame`).
 */

import { DIM_INDEX, G_BODY } from './descriptor';

export interface AffineGains {
  /** Fraction of width per descriptor unit (1.0 = ±30°). */
  yaw_px_per_unit: number;
  /** Fraction of height per unit. */
  pitch_px_per_unit: number;
  /** Degrees per unit (1.0 = 30°); < 1 keeps it subtle. */
  roll_deg_per_unit: number;
  pitch_scale_per_unit: number;
  body_x_frac: number;
  body_y_frac: number;
  max_translate_frac: number;
  max_rotate_deg: number;
  max_scale_dev: number;
  /** Rotate about the face region, not the image centre. */
  pivot_y_frac: number;
  // Idle micro-motion when the user is still (reaction levels §4.4). Driven by the
  // matcher's tick counter, never by an RNG or the wall clock, or the ports diverge.
  breathe_hz: number;
  breathe_ty_frac: number;
  breathe_scale: number;
  // Head-only mode (`warpRegion = "head"`). Far tighter than the full-frame caps: a head
  // that translates away from a static body opens a seam at the collar ("o pescoço saindo
  // do corpo"), and scaling the head alone makes it a balloon.
  head_max_translate_frac: number;
  head_max_rotate_deg: number;
}

export const DEFAULT_AFFINE_GAINS: AffineGains = {
  yaw_px_per_unit: 0.1,
  pitch_px_per_unit: 0.06,
  roll_deg_per_unit: 12.0,
  pitch_scale_per_unit: 0.04,
  body_x_frac: 0.15,
  body_y_frac: 0.1,
  max_translate_frac: 0.18,
  max_rotate_deg: 15.0,
  max_scale_dev: 0.1,
  pivot_y_frac: 0.35,
  breathe_hz: 0.2,
  breathe_ty_frac: 0.004,
  breathe_scale: 0.002,
  head_max_translate_frac: 0.05,
  head_max_rotate_deg: 6.0,
};

export interface AffineParams {
  /** Pixels. */
  tx: number;
  ty: number;
  rot_deg: number;
  scale: number;
  pivot: [number, number];
}

export function isIdentity(p: AffineParams, eps = 1e-3): boolean {
  return Math.abs(p.tx) < 0.5 && Math.abs(p.ty) < 0.5 && Math.abs(p.rot_deg) < 0.05 && Math.abs(p.scale - 1.0) < eps;
}

/**
 * Residual -> tx/ty/rot/scale, clamped by the level's caps.
 *
 * `breathingT` (seconds, derived from the matcher tick counter) adds the §4.4
 * micro-oscillation *before* the caps, so a breathing avatar still respects
 * `max_translate_frac` / `max_scale_dev` exactly.
 */
export function paramsFromResidual(
  residual: ArrayLike<number>,
  width: number,
  height: number,
  gains?: Partial<AffineGains> | null,
  strength = 1.0,
  breathingT?: number | null,
): AffineParams {
  const g: AffineGains = { ...DEFAULT_AFFINE_GAINS, ...(gains || {}) };
  const yaw = Number(residual[DIM_INDEX.headYaw]) || 0;
  const pitch = Number(residual[DIM_INDEX.headPitch]) || 0;
  const roll = Number(residual[DIM_INDEX.headRoll]) || 0;
  const bx = Number(residual[DIM_INDEX.bodyX]) || 0;
  const by = Number(residual[DIM_INDEX.bodyY]) || 0;
  let tx = (yaw * g.yaw_px_per_unit + bx * g.body_x_frac) * width * strength;
  let ty = (-pitch * g.pitch_px_per_unit - by * g.body_y_frac) * height * strength;
  let scaleDev = pitch * g.pitch_scale_per_unit * strength;
  if (breathingT !== undefined && breathingT !== null) {
    const ph = 2.0 * Math.PI * g.breathe_hz * breathingT;
    ty += g.breathe_ty_frac * height * Math.sin(ph);
    scaleDev += g.breathe_scale * Math.sin(ph + Math.PI / 3.0);
  }
  const lim = g.max_translate_frac;
  tx = Math.max(-lim * width, Math.min(lim * width, tx));
  ty = Math.max(-lim * height, Math.min(lim * height, ty));
  const rot = Math.max(-g.max_rotate_deg, Math.min(g.max_rotate_deg, -roll * g.roll_deg_per_unit * strength));
  const scale = 1.0 + Math.max(-g.max_scale_dev, Math.min(g.max_scale_dev, scaleDev));
  return { tx, ty, rot_deg: rot, scale, pivot: [width * 0.5, height * g.pivot_y_frac] };
}

/**
 * `resolveOptions().affine` -> {@link AffineGains} (caps only; the per-unit gains and
 * the pivot stay at their defaults at every level, see §2.5).
 */
export function gainsFromOptions(affineOpts?: Partial<AffineGains> | null): AffineGains {
  const g: AffineGains = { ...DEFAULT_AFFINE_GAINS };
  for (const key of [
    'max_translate_frac',
    'max_rotate_deg',
    'max_scale_dev',
    'head_max_translate_frac',
    'head_max_rotate_deg',
  ] as const) {
    const v = (affineOpts || {})[key];
    if (v !== undefined && v !== null) g[key] = Number(v);
  }
  return g;
}

// --------------------------------------------------------------------- head region
//
// "Eu mexo a cabeça e ela mexe TUDO": warping the whole frame slides the shoulders and
// the background with the head, which reads as the panel sliding, not as a person
// turning. The residual belongs to the head, so the warp is composited through a
// feathered head mask and the body pixels below the neck stay exactly as decoded.
//
// The region comes from the CHOSEN FRAME's own descriptor, inverting the BODY formulas
// of `descriptor.poseDims` (all quantities are fractions of the image, x right, y down):
//
//   SW      = 0.35 + bodyScale * 0.20                     shoulder width
//   shMid   = (0.5 + bodyX * 1.5 * SW, 0.5 - bodyY * 1.5 * SW)
//   cEye    = (shMid.x + headX * 0.5 * SW,
//              shMid.y - SW * (0.7 + headY * 0.3))         eye centre
//   W       = SW * (0.45 + faceScale * 0.20)               cheek-to-cheek width
//
// ...and the ellipse is drawn generously around it (the head is taller than it is wide,
// and hair/ears/chin have to be inside or the mask edge cuts through the face).

/** Half-width = 1.20 × cheek width. */
export const HEAD_RX_PER_W = 1.2;
/** Half-height = 1.65 × cheek width. */
export const HEAD_RY_PER_W = 1.65;
/** Ellipse centre sits below the eye line by 0.30 × cheek width. */
export const HEAD_DROP_PER_W = 0.3;
/** Soft edge, fraction of the frame height (the neck line). */
export const HEAD_FEATHER_FRAC = 0.08;
/** ...but never less than 12 % of the head's own height. */
export const HEAD_FEATHER_MIN_OF_HEAD = 0.12;
/** Fallback when the frame carries no BODY group: the upper 45 % of the frame. */
export const HEAD_FALLBACK: [number, number, number, number] = [0.5, 0.225, 0.3, 0.225];

/** Feathered ellipse the residual warp is allowed to touch. Fractions of the frame. */
export interface HeadRegion {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  feather: number;
}

export function headRegionKey(r: HeadRegion, width: number, height: number): string {
  return [
    Math.trunc(width),
    Math.trunc(height),
    r.cx.toFixed(3),
    r.cy.toFixed(3),
    r.rx.toFixed(3),
    r.ry.toFixed(3),
    r.feather.toFixed(3),
  ].join('|');
}

const clamp01 = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Head ellipse of one bank frame, from its own headX/headY/faceScale (+ body) dims. */
export function headRegionFromFrame(
  frameDesc: ArrayLike<number> | null | undefined,
  mask = 0xff,
  feather: number = HEAD_FEATHER_FRAC,
): HeadRegion {
  const fb: HeadRegion = {
    cx: HEAD_FALLBACK[0],
    cy: HEAD_FALLBACK[1],
    rx: HEAD_FALLBACK[2],
    ry: HEAD_FALLBACK[3],
    feather,
  };
  if (!frameDesc || !((Math.trunc(mask) >> G_BODY) & 1)) return fb;
  if (frameDesc.length <= DIM_INDEX.faceScale) return fb;
  const sw = 0.35 + Number(frameDesc[DIM_INDEX.bodyScale]) * 0.2;
  if (!(sw > 0.05 && sw < 1.5)) return fb;
  const shX = 0.5 + Number(frameDesc[DIM_INDEX.bodyX]) * 1.5 * sw;
  const shY = 0.5 - Number(frameDesc[DIM_INDEX.bodyY]) * 1.5 * sw;
  const eyeX = shX + Number(frameDesc[DIM_INDEX.headX]) * 0.5 * sw;
  const eyeY = shY - sw * (0.7 + Number(frameDesc[DIM_INDEX.headY]) * 0.3);
  const w = sw * (0.45 + Number(frameDesc[DIM_INDEX.faceScale]) * 0.2);
  if (!(w > 0.02 && w < 1.5) || !Number.isFinite(eyeX) || !Number.isFinite(eyeY) || !Number.isFinite(w)) return fb;
  return {
    cx: clamp01(eyeX, 0.0, 1.0),
    cy: clamp01(eyeY + HEAD_DROP_PER_W * w, 0.0, 1.0),
    rx: clamp01(HEAD_RX_PER_W * w, 0.05, 1.0),
    ry: clamp01(HEAD_RY_PER_W * w, 0.05, 1.0),
    feather,
  };
}

/**
 * Ramp width in units of the ellipse radius, at least {@link HEAD_FEATHER_MIN_OF_HEAD}
 * of the head's own height (the head is `2·ry` tall, so 12 % of it is 0.24 radii).
 */
export function featherNorm(region: HeadRegion): number {
  const ry = Math.max(1e-3, region.ry);
  return Math.min(0.95, Math.max(2.0 * HEAD_FEATHER_MIN_OF_HEAD, region.feather / ry));
}

/**
 * Alpha of the head mask at one normalised point: 1 in the core of the head, ramping to
 * **exactly 0 on the ellipse boundary** — the neck line — and 0 everywhere outside it.
 *
 * The ramp points INWARD on purpose: an outward ramp would let a fraction of the warp
 * reach the collar, which is what made the neck look detached in the first live test.
 * With this mask no pixel outside the ellipse is touched at all, so the body is
 * byte-identical to the decoded frame.
 */
export function regionAlphaAt(region: HeadRegion, xFrac: number, yFrac: number): number {
  const rx = Math.max(1e-3, region.rx);
  const ry = Math.max(1e-3, region.ry);
  const dx = (xFrac - region.cx) / rx;
  const dy = (yFrac - region.cy) / ry;
  const r = Math.sqrt(dx * dx + dy * dy);
  const f = featherNorm(region);
  const a = (1.0 - r) / f;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/**
 * `(h, w)` Float32 alpha map in [0, 1] — the exact Python `region_alpha` output, for
 * tests and for renderers that composite pixel-wise. The canvas path uses a radial
 * gradient instead (same ramp, no per-pixel JS).
 */
export function regionAlpha(width: number, height: number, region: HeadRegion): Float32Array {
  const h = Math.trunc(height);
  const w = Math.trunc(width);
  const out = new Float32Array(h * w);
  for (let y = 0; y < h; y++) {
    const yf = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = regionAlphaAt(region, (x + 0.5) / w, yf);
    }
  }
  return out;
}

/**
 * Re-aim a full-frame residual at a head that has to stay attached to its body.
 *
 * Three changes, all of them the difference between "she turned her head" and "her head
 * slid off": the pivot moves to the **base of the neck** (bottom centre of the head
 * ellipse) so a rotation swings the chin instead of shearing the collar; the scale is
 * dropped to 1.0 (scaling the head alone changes head-to-body proportion, which reads as
 * a different person); and tx/ty/rot are re-clamped to the much tighter head caps.
 */
export function paramsForHead(
  p: AffineParams,
  region: HeadRegion,
  width: number,
  height: number,
  gains?: Partial<AffineGains> | null,
): AffineParams {
  const g: AffineGains = { ...DEFAULT_AFFINE_GAINS, ...(gains || {}) };
  const limT = g.head_max_translate_frac;
  const limR = g.head_max_rotate_deg;
  return {
    tx: Math.max(-limT * width, Math.min(limT * width, p.tx)),
    ty: Math.max(-limT * height, Math.min(limT * height, p.ty)),
    rot_deg: Math.max(-limR, Math.min(limR, p.rot_deg)),
    scale: 1.0,
    pivot: [region.cx * width, Math.min(height, (region.cy + region.ry) * height)],
  };
}

/** Pixel bbox of the head ellipse plus a margin for the pixels the warp pulls in. */
export function regionBox(
  width: number,
  height: number,
  region: HeadRegion,
  marginFrac = 0.08,
): [number, number, number, number] {
  const mx = marginFrac * width;
  const my = marginFrac * height;
  const x0 = Math.max(0, Math.floor((region.cx - region.rx) * width - mx));
  const y0 = Math.max(0, Math.floor((region.cy - region.ry) * height - my));
  const x1 = Math.min(width, Math.ceil((region.cx + region.rx) * width + mx));
  const y1 = Math.min(height, Math.ceil((region.cy + region.ry) * height + my));
  if (x1 <= x0 || y1 <= y0) return [0, 0, width, height];
  return [x0, y0, x1, y1];
}

/** Where a residual warp is allowed to act. */
export type WarpRegion = 'head' | 'full';
