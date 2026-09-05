/**
 * PoseDescriptor v1 — the shared pose space of Ania 2.0.
 *
 * 1:1 TypeScript port of `AniaAPP/src/ania_player/plugins/mocap_webcam/descriptor.py`.
 * See that file's docstring and `wiki/concepts/ania-2-0-pose-descriptor-and-motion-graph.md`
 * for the full spec. Do not change dim order / meaning / constants without bumping
 * {@link DESCRIPTOR_VERSION} on both sides.
 *
 * Landmark input shapes
 * ----------------------
 * `computeDescriptor` accepts each of face/pose/hands as either:
 *   - a flat row-major `Float64Array | number[]` with a fixed stride: 3 for face
 *     and hands (x, y, z), 4 for pose (x, y, z, visibility) — visibility is always
 *     read from column 3 for a flat pose array;
 *   - an array of MediaPipe-JS-shaped `{x, y, z?, visibility?}` points, in which
 *     case `visibility` is read per-point when present (pose only).
 */

export const DESCRIPTOR_VERSION = 1;
export const NDIMS = 48;
export const NUSED = 40;

// ---- groups -----------------------------------------------------------------
export const G_HEAD = 0;
export const G_MOUTH = 1;
export const G_EYES = 2;
export const G_BROWS = 3;
export const G_BODY = 4;
export const G_HAND_L = 5;
export const G_HAND_R = 6;
export const G_RESERVED = 7;
export const GROUP_NAMES = [
  'HEAD', 'MOUTH', 'EYES', 'BROWS', 'BODY', 'HAND_L', 'HAND_R', 'RESERVED',
] as const;
export const FACE_GROUPS = (1 << G_HEAD) | (1 << G_MOUTH) | (1 << G_EYES) | (1 << G_BROWS);
export const POSE_GROUPS = (1 << G_BODY) | (1 << G_HAND_L) | (1 << G_HAND_R);

// ---- dims -------------------------------------------------------------------
interface DimSpec {
  index: number;
  name: string;
  group: number;
  weight: number;
  retarget: boolean;
}

const BASE_DIMS: DimSpec[] = [
  { index: 0, name: 'headYaw', group: G_HEAD, weight: 3.0, retarget: true },
  { index: 1, name: 'headPitch', group: G_HEAD, weight: 2.0, retarget: true },
  { index: 2, name: 'headRoll', group: G_HEAD, weight: 1.5, retarget: true },
  { index: 3, name: 'mouthOpen', group: G_MOUTH, weight: 1.5, retarget: true },
  { index: 4, name: 'jawOpen', group: G_MOUTH, weight: 0.5, retarget: false },
  { index: 5, name: 'mouthSmile', group: G_MOUTH, weight: 1.0, retarget: false },
  { index: 6, name: 'mouthFrown', group: G_MOUTH, weight: 0.5, retarget: false },
  { index: 7, name: 'mouthPucker', group: G_MOUTH, weight: 0.5, retarget: false },
  { index: 8, name: 'mouthWidth', group: G_MOUTH, weight: 0.5, retarget: true },
  { index: 9, name: 'eyeBlinkL', group: G_EYES, weight: 0.4, retarget: false },
  { index: 10, name: 'eyeBlinkR', group: G_EYES, weight: 0.4, retarget: false },
  { index: 11, name: 'eyeWide', group: G_EYES, weight: 0.3, retarget: false },
  { index: 12, name: 'gazeX', group: G_EYES, weight: 0.3, retarget: false },
  { index: 13, name: 'gazeY', group: G_EYES, weight: 0.3, retarget: false },
  { index: 14, name: 'browRaise', group: G_BROWS, weight: 0.8, retarget: true },
  { index: 15, name: 'browInnerUp', group: G_BROWS, weight: 0.3, retarget: false },
  { index: 16, name: 'browDown', group: G_BROWS, weight: 0.5, retarget: false },
  { index: 17, name: 'shoulderTilt', group: G_BODY, weight: 1.5, retarget: true },
  { index: 18, name: 'bodyX', group: G_BODY, weight: 1.0, retarget: true },
  { index: 19, name: 'bodyY', group: G_BODY, weight: 0.7, retarget: true },
  { index: 20, name: 'bodyScale', group: G_BODY, weight: 0.7, retarget: true },
  { index: 21, name: 'headX', group: G_BODY, weight: 1.5, retarget: true },
  { index: 22, name: 'headY', group: G_BODY, weight: 1.0, retarget: true },
  { index: 23, name: 'faceScale', group: G_BODY, weight: 0.8, retarget: true },
  { index: 24, name: 'shoulderRaiseL', group: G_BODY, weight: 0.5, retarget: true },
  { index: 25, name: 'shoulderRaiseR', group: G_BODY, weight: 0.5, retarget: true },
  { index: 26, name: 'handL_vis', group: G_HAND_L, weight: 2.0, retarget: false },
  { index: 27, name: 'handL_x', group: G_HAND_L, weight: 1.5, retarget: true },
  { index: 28, name: 'handL_y', group: G_HAND_L, weight: 1.5, retarget: true },
  { index: 29, name: 'handL_open', group: G_HAND_L, weight: 0.5, retarget: false },
  { index: 30, name: 'handL_index', group: G_HAND_L, weight: 0.5, retarget: false },
  { index: 31, name: 'elbowL_x', group: G_HAND_L, weight: 0.6, retarget: true },
  { index: 32, name: 'elbowL_y', group: G_HAND_L, weight: 0.6, retarget: true },
  { index: 33, name: 'handR_vis', group: G_HAND_R, weight: 2.0, retarget: false },
  { index: 34, name: 'handR_x', group: G_HAND_R, weight: 1.5, retarget: true },
  { index: 35, name: 'handR_y', group: G_HAND_R, weight: 1.5, retarget: true },
  { index: 36, name: 'handR_open', group: G_HAND_R, weight: 0.5, retarget: false },
  { index: 37, name: 'handR_index', group: G_HAND_R, weight: 0.5, retarget: false },
  { index: 38, name: 'elbowR_x', group: G_HAND_R, weight: 0.6, retarget: true },
  { index: 39, name: 'elbowR_y', group: G_HAND_R, weight: 0.6, retarget: true },
];
for (let r = NUSED; r < NDIMS; r++) {
  BASE_DIMS.push({ index: r, name: `reserved${r}`, group: G_RESERVED, weight: 0.0, retarget: false });
}

export const DIM_NAMES: string[] = BASE_DIMS.map((d) => d.name);
export const DIM_INDEX: Record<string, number> = Object.fromEntries(BASE_DIMS.map((d) => [d.name, d.index]));
export const DIM_GROUP: Int32Array = Int32Array.from(BASE_DIMS.map((d) => d.group));
export const WEIGHTS: Float64Array = Float64Array.from(BASE_DIMS.map((d) => d.weight));
export const RETARGET: boolean[] = BASE_DIMS.map((d) => d.retarget);

/** Neutral pose ("hands down", face level, body centred). Non-mirrored: the
 * subject's LEFT hand appears on image-RIGHT (+x). */
export const NEUTRAL: Float64Array = (() => {
  const n = new Float64Array(NDIMS);
  n[DIM_INDEX.handL_x] = 0.3;
  n[DIM_INDEX.handR_x] = -0.3;
  n[DIM_INDEX.handL_y] = -0.55;
  n[DIM_INDEX.handR_y] = -0.55;
  n[DIM_INDEX.handL_open] = 0.6;
  n[DIM_INDEX.handR_open] = 0.6;
  n[DIM_INDEX.elbowL_x] = 0.6;
  n[DIM_INDEX.elbowR_x] = -0.6;
  n[DIM_INDEX.elbowL_y] = -0.35;
  n[DIM_INDEX.elbowR_y] = -0.35;
  return n;
})();

/** Negate lateral dims, swap L/R pairs. */
export const MIRROR_NEGATE: number[] = [
  'headYaw', 'headRoll', 'gazeX', 'shoulderTilt', 'bodyX', 'headX',
  'handL_x', 'elbowL_x', 'handR_x', 'elbowR_x',
].map((n) => DIM_INDEX[n]);

export const MIRROR_SWAP: [number, number][] = [
  [DIM_INDEX.eyeBlinkL, DIM_INDEX.eyeBlinkR],
  [DIM_INDEX.shoulderRaiseL, DIM_INDEX.shoulderRaiseR],
  ...Array.from({ length: 7 }, (_, i): [number, number] => [DIM_INDEX.handL_vis + i, DIM_INDEX.handR_vis + i]),
];

// ---- landmark ids (MediaPipe FaceMesh 478 / Pose 33 / Hand 21) --------------
export const F_NOSE_TIP = 1;
export const F_CHEEK_R = 234;
export const F_CHEEK_L = 454; // subject-right cheek is on image-LEFT (non-mirrored)
export const F_EYE_R: [number, number] = [33, 133]; // subject-right eye corners
export const F_EYE_L: [number, number] = [362, 263]; // subject-left eye corners
export const F_EYE_R_LIDS: [number, number][] = [[160, 144], [158, 153]]; // (upper, lower)
export const F_EYE_L_LIDS: [number, number][] = [[385, 380], [387, 373]];
export const F_IRIS_R = 468;
export const F_IRIS_L = 473;
export const F_LIP_PAIRS: [number, number][] = [[13, 14], [82, 87], [312, 317]];
export const F_MOUTH_CORNERS: [number, number] = [78, 308];
export const F_BROW_R = 105;
export const F_BROW_L = 334;

export const P_NOSE = 0;
export const P_EYE_L = 2;
export const P_EYE_R = 5;
export const P_EAR_L = 7;
export const P_EAR_R = 8;
export const P_SHOULDER_L = 11;
export const P_SHOULDER_R = 12;
export const P_ELBOW_L = 13;
export const P_ELBOW_R = 14;
export const P_WRIST_L = 15;
export const P_WRIST_R = 16;

export const H_WRIST = 0;
export const H_MCP_MID = 9;
export const H_TIPS: [number, number, number, number] = [8, 12, 16, 20]; // index, middle, ring, pinky

export const BLENDSHAPE_NAMES = [
  'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthPucker', 'mouthFunnel', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp',
  'browDownLeft', 'browDownRight',
] as const;

const EPS = 1e-6;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const dist = (x1: number, y1: number, x2: number, y2: number): number => Math.hypot(x1 - x2, y1 - y2);

const rotatePoint = (x: number, y: number, cx: number, cy: number, angle: number): [number, number] => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + c * dx - s * dy, cy + s * dx + c * dy];
};

// ---- landmark input shapes ---------------------------------------------------

/** Flat row-major landmarks: `[x0,y0,z0, x1,y1,z1, ...]` (stride 3) or with a
 * trailing visibility column for pose (stride 4). */
export type FlatLandmarks = Float64Array | number[];

/** MediaPipe-JS landmark point shape. */
export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export type Landmarks = FlatLandmarks | ReadonlyArray<LandmarkPoint>;

interface LandmarkView {
  count: number;
  hasVis: boolean;
  x(i: number): number;
  y(i: number): number;
  vis(i: number): number;
}

const isFlat = (input: Landmarks): input is FlatLandmarks =>
  input instanceof Float64Array ||
  (Array.isArray(input) && (input.length === 0 || typeof input[0] === 'number'));

const viewFlat = (flat: FlatLandmarks, stride: number): LandmarkView => {
  const count = Math.floor(flat.length / stride);
  const hasVis = stride >= 4;
  return {
    count,
    hasVis,
    x: (i) => flat[i * stride],
    y: (i) => flat[i * stride + 1],
    vis: (i) => (hasVis ? flat[i * stride + 3] : 1),
  };
};

const viewObjects = (pts: ReadonlyArray<LandmarkPoint>): LandmarkView => {
  const hasVis = pts.length > 0 && typeof pts[0].visibility === 'number' && Number.isFinite(pts[0].visibility);
  return {
    count: pts.length,
    hasVis,
    x: (i) => pts[i].x,
    y: (i) => pts[i].y,
    vis: (i) => (hasVis ? (pts[i].visibility as number) : 1),
  };
};

const view = (input: Landmarks | null | undefined, stride: number): LandmarkView | null => {
  if (input == null) return null;
  return isFlat(input) ? viewFlat(input, stride) : viewObjects(input);
};

// ---- descriptor construction --------------------------------------------------

export function blank(): [Float64Array, number] {
  return [Float64Array.from(NEUTRAL), 0];
}

function faceDims(f: LandmarkView, blend: Record<string, number> | null | undefined, out: Float64Array): void {
  const cRx = (f.x(F_EYE_R[0]) + f.x(F_EYE_R[1])) * 0.5;
  const cRy = (f.y(F_EYE_R[0]) + f.y(F_EYE_R[1])) * 0.5;
  const cLx = (f.x(F_EYE_L[0]) + f.x(F_EYE_L[1])) * 0.5;
  const cLy = (f.y(F_EYE_L[0]) + f.y(F_EYE_L[1])) * 0.5;
  const cEyeX = (cRx + cLx) * 0.5;
  const cEyeY = (cRy + cLy) * 0.5;
  const roll = Math.atan2(cLy - cRy, cLx - cRx);
  out[2] = clamp(roll / (Math.PI / 6.0), -1.0, 1.0);

  // De-roll every needed face point about the eye centre before the ratio features.
  const rot = (i: number): [number, number] => rotatePoint(f.x(i), f.y(i), cEyeX, cEyeY, -roll);

  const [cheekLx, cheekLy] = rot(F_CHEEK_L);
  const [cheekRx, cheekRy] = rot(F_CHEEK_R);
  const W = dist(cheekLx, cheekLy, cheekRx, cheekRy) + EPS;
  const [eR0x, eR0y] = rot(F_EYE_R[0]);
  const [eR1x, eR1y] = rot(F_EYE_R[1]);
  const [eL0x, eL0y] = rot(F_EYE_L[0]);
  const [eL1x, eL1y] = rot(F_EYE_L[1]);
  const cR2x = (eR0x + eR1x) * 0.5;
  const cR2y = (eR0y + eR1y) * 0.5;
  const cL2x = (eL0x + eL1x) * 0.5;
  const cL2y = (eL0y + eL1y) * 0.5;
  const [nosex, nosey] = rot(F_NOSE_TIP);

  // HEAD
  const yawR = (2.0 * nosex - cheekRx - cheekLx) / W;
  out[0] = clamp(yawR / 0.5, -1.0, 1.0);
  const cEye2y = (cR2y + cL2y) * 0.5;
  const pitchR = (nosey - cEye2y) / W;
  out[1] = clamp((0.3 - pitchR) / 0.15, -1.0, 1.0);

  // MOUTH
  const [mc0x, mc0y] = rot(F_MOUTH_CORNERS[0]);
  const [mc1x, mc1y] = rot(F_MOUTH_CORNERS[1]);
  const mw = dist(mc0x, mc0y, mc1x, mc1y) + EPS;
  let lipSum = 0;
  for (const [a, b] of F_LIP_PAIRS) {
    const [ax, ay] = rot(a);
    const [bx, by] = rot(b);
    lipSum += dist(ax, ay, bx, by);
  }
  const mar = lipSum / 3.0 / mw;
  out[3] = clamp(mar / 0.6, 0.0, 1.0);
  out[8] = clamp((mw / W - 0.35) / 0.15, -1.0, 1.0);

  // EYES (EAR)
  const eyeWR = dist(eR0x, eR0y, eR1x, eR1y) + EPS;
  const eyeWL = dist(eL0x, eL0y, eL1x, eL1y) + EPS;
  let earRSum = 0;
  for (const [a, b] of F_EYE_R_LIDS) {
    const [ax, ay] = rot(a);
    const [bx, by] = rot(b);
    earRSum += dist(ax, ay, bx, by);
  }
  let earLSum = 0;
  for (const [a, b] of F_EYE_L_LIDS) {
    const [ax, ay] = rot(a);
    const [bx, by] = rot(b);
    earLSum += dist(ax, ay, bx, by);
  }
  const earR = earRSum / (2.0 * eyeWR);
  const earL = earLSum / (2.0 * eyeWL);
  out[9] = clamp((0.28 - earL) / 0.15, 0.0, 1.0);
  out[10] = clamp((0.28 - earR) / 0.15, 0.0, 1.0);
  if (f.count > F_IRIS_L) {
    const [irRx, irRy] = rot(F_IRIS_R);
    const [irLx, irLy] = rot(F_IRIS_L);
    const gx = ((irRx - cR2x) / eyeWR + (irLx - cL2x) / eyeWL) * 0.5;
    const gy = ((irRy - cR2y) / eyeWR + (irLy - cL2y) / eyeWL) * 0.5;
    out[12] = clamp(gx / 0.25, -1.0, 1.0);
    out[13] = clamp(-gy / 0.12, -1.0, 1.0);
  } else {
    out[12] = 0.0;
    out[13] = 0.0;
  }

  // BROWS
  const [, browRy] = rot(F_BROW_R);
  const [, browLy] = rot(F_BROW_L);
  const browR = (cR2y - browRy + (cL2y - browLy)) / (2.0 * W);
  out[14] = clamp((browR - 0.12) / 0.06, -1.0, 1.0);

  // Blendshape-only dims (0 when the estimator has none).
  const b = blend || {};
  const bs = (name: string): number => clamp(b[name] ?? 0, 0.0, 1.0);
  out[4] = bs('jawOpen');
  out[5] = (bs('mouthSmileLeft') + bs('mouthSmileRight')) * 0.5;
  out[6] = (bs('mouthFrownLeft') + bs('mouthFrownRight')) * 0.5;
  out[7] = Math.max(bs('mouthPucker'), bs('mouthFunnel'));
  out[11] = (bs('eyeWideLeft') + bs('eyeWideRight')) * 0.5;
  out[15] = bs('browInnerUp');
  out[16] = (bs('browDownLeft') + bs('browDownRight')) * 0.5;
}

function handOpenness(h: LandmarkView): [number, number] {
  const wx = h.x(H_WRIST);
  const wy = h.y(H_WRIST);
  const palm = dist(h.x(H_MCP_MID), h.y(H_MCP_MID), wx, wy) + EPS;
  const opens = H_TIPS.map((t) => clamp((dist(h.x(t), h.y(t), wx, wy) / palm - 1.0) / 0.8, 0.0, 1.0));
  const openMean = (opens[0] + opens[1] + opens[2] + opens[3]) / 4.0;
  const index = clamp(opens[0] - (opens[1] + opens[2] + opens[3]) / 3.0, 0.0, 1.0);
  return [openMean, index];
}

/** Assign hand landmark sets to (left, right) by nearest Pose wrist — never by
 * the handedness label (which assumes a mirrored input). */
function assignHands(pose: LandmarkView, hands: LandmarkView[]): [LandmarkView | null, LandmarkView | null] {
  if (!hands || hands.length === 0) return [null, null];
  const wlx = pose.x(P_WRIST_L);
  const wly = pose.y(P_WRIST_L);
  const wrx = pose.x(P_WRIST_R);
  const wry = pose.y(P_WRIST_R);
  const cands = hands.slice(0, 2).map((h) => {
    const hx = h.x(H_WRIST);
    const hy = h.y(H_WRIST);
    return { dl: dist(hx, hy, wlx, wly), dr: dist(hx, hy, wrx, wry), h };
  });
  if (cands.length === 1) {
    const { dl, dr, h } = cands[0];
    return dl <= dr ? [h, null] : [null, h];
  }
  const [c0, c1] = cands;
  if (c0.dl + c1.dr <= c0.dr + c1.dl) return [c0.h, c1.h];
  return [c1.h, c0.h];
}

function poseDims(
  p: LandmarkView,
  hands: LandmarkView[],
  face: LandmarkView | null,
  out: Float64Array,
  visThreshold = 0.3
): void {
  const shLx = p.x(P_SHOULDER_L);
  const shLy = p.y(P_SHOULDER_L);
  const shRx = p.x(P_SHOULDER_R);
  const shRy = p.y(P_SHOULDER_R);
  const shMidX = (shLx + shRx) * 0.5;
  const shMidY = (shLy + shRy) * 0.5;
  const SW = dist(shLx, shLy, shRx, shRy) + EPS;

  out[17] = clamp(Math.atan2(shLy - shRy, shLx - shRx) / (Math.PI / 8.0), -1.0, 1.0);
  out[18] = clamp((shMidX - 0.5) / SW / 1.5, -1.0, 1.0);
  out[19] = clamp((0.5 - shMidY) / SW / 1.5, -1.0, 1.0);
  out[20] = clamp((SW - 0.35) / 0.2, -1.0, 1.0);

  let cEyeX: number;
  let cEyeY: number;
  let W: number;
  if (face) {
    cEyeX = (face.x(F_EYE_R[0]) + face.x(F_EYE_R[1]) + face.x(F_EYE_L[0]) + face.x(F_EYE_L[1])) * 0.25;
    cEyeY = (face.y(F_EYE_R[0]) + face.y(F_EYE_R[1]) + face.y(F_EYE_L[0]) + face.y(F_EYE_L[1])) * 0.25;
    W = dist(face.x(F_CHEEK_L), face.y(F_CHEEK_L), face.x(F_CHEEK_R), face.y(F_CHEEK_R)) + EPS;
  } else {
    cEyeX = (p.x(P_EYE_L) + p.x(P_EYE_R)) * 0.5;
    cEyeY = (p.y(P_EYE_L) + p.y(P_EYE_R)) * 0.5;
    W = dist(p.x(P_EAR_L), p.y(P_EAR_L), p.x(P_EAR_R), p.y(P_EAR_R)) + EPS;
  }
  out[21] = clamp((cEyeX - shMidX) / SW / 0.5, -1.0, 1.0);
  out[22] = clamp(((shMidY - cEyeY) / SW - 0.7) / 0.3, -1.0, 1.0);
  out[23] = clamp((W / SW - 0.45) / 0.2, -1.0, 1.0);
  out[24] = clamp((0.5 - (shLy - p.y(P_EAR_L)) / SW) / 0.2, -1.0, 1.0);
  out[25] = clamp((0.5 - (shRy - p.y(P_EAR_R)) / SW) / 0.2, -1.0, 1.0);

  const [hL, hR] = assignHands(p, hands);
  const vis = (i: number): number => (p.hasVis ? clamp(p.vis(i), 0.0, 1.0) : 1.0);

  const slots: [number, number, number, LandmarkView | null, number][] = [
    [26, P_WRIST_L, P_ELBOW_L, hL, 1.0],
    [33, P_WRIST_R, P_ELBOW_R, hR, -1.0],
  ];
  for (const [base, wristI, elbowI, hand, sign] of slots) {
    const v = vis(wristI);
    out[base + 0] = v;
    if (v < visThreshold) {
      out[base + 1] = 0.3 * sign;
      out[base + 2] = -0.55;
      out[base + 3] = 0.6;
      out[base + 4] = 0.0;
      out[base + 5] = 0.6 * sign;
      out[base + 6] = -0.35;
      continue;
    }
    const wx = p.x(wristI);
    const wy = p.y(wristI);
    const ex = p.x(elbowI);
    const ey = p.y(elbowI);
    out[base + 1] = clamp((wx - shMidX) / SW / 2.5, -1.0, 1.0);
    out[base + 2] = clamp((shMidY - wy) / SW / 2.5, -1.0, 1.0);
    if (hand) {
      const [o, ix] = handOpenness(hand);
      out[base + 3] = o;
      out[base + 4] = ix;
    } else {
      out[base + 3] = 0.6;
      out[base + 4] = 0.0;
    }
    out[base + 5] = clamp((ex - shMidX) / SW / 2.5, -1.0, 1.0);
    out[base + 6] = clamp((shMidY - ey) / SW / 2.5, -1.0, 1.0);
  }
}

export function applyMirror(values: Float64Array, mask: number): [Float64Array, number] {
  const v = Float64Array.from(values);
  for (const [a, b] of MIRROR_SWAP) {
    v[a] = values[b];
    v[b] = values[a];
  }
  for (const idx of MIRROR_NEGATE) v[idx] *= -1.0;
  let m = mask;
  const lBit = 1 << G_HAND_L;
  const rBit = 1 << G_HAND_R;
  const lOn = (m & lBit) !== 0;
  const rOn = (m & rBit) !== 0;
  m &= ~(lBit | rBit);
  if (lOn) m |= rBit;
  if (rOn) m |= lBit;
  return [v, m];
}

/**
 * Build a PoseDescriptor v1 from generic landmark arrays.
 *
 * @param face image-normalised face landmarks (>=468 points), or null
 * @param blend `{blendshapeName: score}`, or null
 * @param pose image-normalised pose landmarks (33 points), or null
 * @param hands 0..2 hand landmark sets, or null
 * @param mirror self-view webcam: negate lateral dims + swap L/R groups
 * @returns `[values (48 floats, float32 precision), mask]`
 */
export function computeDescriptor(
  face?: Landmarks | null,
  blend?: Record<string, number> | null,
  pose?: Landmarks | null,
  hands?: (Landmarks | null | undefined)[] | null,
  mirror = false
): [Float64Array, number] {
  const out = Float64Array.from(NEUTRAL);
  let mask = 0;
  const faceView = view(face ?? null, 3);
  const hasFace = faceView !== null && faceView.count >= 468;
  if (hasFace && faceView) {
    faceDims(faceView, blend ?? null, out);
    mask |= FACE_GROUPS;
  }
  const poseView = view(pose ?? null, 4);
  if (poseView && poseView.count >= 33) {
    const handViews: LandmarkView[] = [];
    for (const h of hands ?? []) {
      const hv = view(h ?? null, 3);
      if (hv) handViews.push(hv);
    }
    poseDims(poseView, handViews, hasFace ? faceView : null, out);
    mask |= POSE_GROUPS;
  }
  // Python casts the assembled float64 buffer to float32 before mirroring.
  const values = new Float64Array(NDIMS);
  for (let i = 0; i < NDIMS; i++) values[i] = Math.fround(out[i]);
  if (mirror) return applyMirror(values, mask);
  return [values, mask];
}

/** Per-dim 0/1 vector of active dims for a group mask. */
export function groupVector(mask: number): Float64Array {
  const bits = new Float64Array(8);
  for (let g = 0; g < 8; g++) bits[g] = (mask >> g) & 1;
  const out = new Float64Array(NDIMS);
  for (let i = 0; i < NDIMS; i++) out[i] = bits[DIM_GROUP[i]];
  return out;
}

/** Approximate (yaw, pitch, roll) in degrees for HUDs / reports. */
export function headDegrees(values: ArrayLike<number>): [number, number, number] {
  return [values[0] * 30.0, values[1] * 20.0, values[2] * 30.0];
}
