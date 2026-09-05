// AniaPlayer — the framework-free canvas renderer + frame loop.
//
// Extracted from the Chrome extension content-script's embedded `AniaPlayer`,
// with ALL extension/DOM-menu/drag UI removed. It owns a <canvas>, decodes the
// avatar's base64 WebP frames into Image objects (cached), and on each rAF tick
// asks the AnimationController which frame to draw.

import { AnimationController } from './animation-controller';
import type { AnimationControllerConfig, AniaAvatarData, MocapWarpState } from '../types';

export interface AniaPlayerRenderOptions {
  width: number;
  height: number;
  /** Override the data-URL mime for frames. Default 'image/webp'. */
  frameMime?: string;
}

export class AniaPlayer {
  public readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private frameImages = new Map<number, HTMLImageElement>();
  private isPlaying = false;
  private animationFrame: number | null = null;
  private lastRenderedFrame = -1;
  private frameMime: string;

  // ---- mocap compositing scratch (allocated lazily, only on the mocap path) ----
  private warpCanvas: HTMLCanvasElement | null = null;
  private warpCtx: CanvasRenderingContext2D | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;
  private maskKey = '';

  public fileData: AniaAvatarData | null = null;
  public animationController: AnimationController | null = null;

  /**
   * @param canvas A target <canvas> to render into.
   * @param options Pixel size + optional frame mime.
   */
  constructor(canvas: HTMLCanvasElement, options: AniaPlayerRenderOptions) {
    this.canvas = canvas;
    this.canvas.width = options.width;
    this.canvas.height = options.height;
    this.frameMime = options.frameMime || 'image/webp';
    this.ctx = this.canvas.getContext('2d');
  }

  /** Decode + cache a single frame Image by index. */
  async loadFrame(index: number): Promise<HTMLImageElement | null> {
    const cached = this.frameImages.get(index);
    if (cached) return cached;
    const frame = this.fileData?.video?.frames?.[index];
    if (!frame) return null;

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.frameImages.set(index, img);
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = frame.startsWith('data:') ? frame : `data:${this.frameMime};base64,${frame}`;
    });
  }

  /** Draw a frame by index (skips redundant redraws of the same frame). */
  async renderFrame(index: number): Promise<void> {
    if (index === this.lastRenderedFrame) return;
    this.lastRenderedFrame = index;
    const img = await this.loadFrame(index);
    if (img && this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /**
   * Draw one mocap tick: the body frame as decoded, then — when the level asked for a
   * head-only warp — the head region re-drawn through the affine transform behind a
   * feathered elliptical mask, and finally the §4.2 alpha blend of the frame we are
   * jumping away from.
   *
   * `warp === null` (mocap off, or the matcher not driving) short-circuits straight
   * back to {@link renderFrame}, which is what keeps the no-mocap output byte-identical.
   */
  async renderMocapFrame(index: number, warp: MocapWarpState | null): Promise<void> {
    if (!warp) return this.renderFrame(index);
    const ctx = this.ctx;
    const img = await this.loadFrame(index);
    if (!img || !ctx) return;
    this.lastRenderedFrame = -1; // a warped frame is never a redundant redraw
    const W = this.canvas.width;
    const H = this.canvas.height;
    const p = warp.params;
    const identity =
      Math.abs(p.tx) < 0.5 && Math.abs(p.ty) < 0.5 && Math.abs(p.rot_deg) < 0.05 && Math.abs(p.scale - 1) < 1e-3;

    ctx.clearRect(0, 0, W, H);
    // 1. the body: the frame exactly as decoded.
    ctx.drawImage(img, 0, 0, W, H);

    // 2. the head: the same frame under the residual transform, composited through the
    //    head ellipse so the shoulders and the background do not slide with it.
    if (!identity) {
      if (warp.warpRegion === 'full' || !warp.region) {
        ctx.save();
        this.applyTransform(ctx, p);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        ctx.restore();
      } else {
        const layer = this.ensureWarpLayer(W, H);
        if (layer) {
          const lctx = layer.ctx;
          lctx.setTransform(1, 0, 0, 1, 0, 0);
          lctx.clearRect(0, 0, W, H);
          lctx.save();
          this.applyTransform(lctx, p);
          lctx.drawImage(img, 0, 0, W, H);
          lctx.restore();
          // punch the warped layer down to the head ellipse
          const mask = this.ensureMask(W, H, warp.region);
          if (mask) {
            lctx.globalCompositeOperation = 'destination-in';
            lctx.drawImage(mask, 0, 0);
            lctx.globalCompositeOperation = 'source-over';
          }
          ctx.drawImage(layer.canvas, 0, 0);
        }
      }
    }

    // 3. the crossfade: the outgoing frame drawn over the top at (1 - alpha).
    const fade = warp.crossfade;
    if (fade && fade.fromFrame >= 0 && fade.alpha < 1) {
      const prev = this.frameImages.get(fade.fromFrame);
      if (prev) {
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = 1 - fade.alpha;
        ctx.drawImage(prev, 0, 0, W, H);
        ctx.globalAlpha = prevAlpha;
      }
    }
  }

  /** `out = R·S·(in - pivot) + pivot + t`, as a canvas transform. */
  private applyTransform(ctx: CanvasRenderingContext2D, p: MocapWarpState['params']): void {
    const [px, py] = p.pivot;
    ctx.translate(px + p.tx, py + p.ty);
    ctx.rotate((p.rot_deg * Math.PI) / 180);
    ctx.scale(p.scale, p.scale);
    ctx.translate(-px, -py);
  }

  private ensureWarpLayer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (!this.warpCanvas || this.warpCanvas.width !== w || this.warpCanvas.height !== h) {
      if (typeof document === 'undefined') return null;
      this.warpCanvas = document.createElement('canvas');
      this.warpCanvas.width = w;
      this.warpCanvas.height = h;
      this.warpCtx = this.warpCanvas.getContext('2d');
    }
    return this.warpCtx ? { canvas: this.warpCanvas, ctx: this.warpCtx } : null;
  }

  /**
   * The feathered head ellipse as an alpha bitmap. Same ramp as the Python
   * `affine.region_alpha`: 1 inside, 0 outside, a linear fall-off of `feather`
   * (measured along the y axis) across the boundary — expressed as a radial gradient
   * on a unit circle that an ellipse transform stretches, so there is no per-pixel JS.
   * Cached per (region, size); the region only changes when the matcher picks another
   * frame, so the per-tick cost is one lookup.
   */
  private ensureMask(w: number, h: number, region: NonNullable<MocapWarpState['region']>): HTMLCanvasElement | null {
    const key = [w, h, region.cx.toFixed(3), region.cy.toFixed(3), region.rx.toFixed(3), region.ry.toFixed(3), region.feather.toFixed(3)].join('|');
    if (this.maskCanvas && this.maskKey === key) return this.maskCanvas;
    if (typeof document === 'undefined') return null;
    if (!this.maskCanvas || this.maskCanvas.width !== w || this.maskCanvas.height !== h) {
      this.maskCanvas = document.createElement('canvas');
      this.maskCanvas.width = w;
      this.maskCanvas.height = h;
      this.maskCtx = this.maskCanvas.getContext('2d');
    }
    const mctx = this.maskCtx;
    if (!mctx) return null;
    const rx = Math.max(1e-3, region.rx);
    const ry = Math.max(1e-3, region.ry);
    const f = Math.max(1e-3, region.feather / ry);
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, w, h);
    mctx.save();
    // work in normalised-ellipse space: a unit circle of radius (1 + f)
    mctx.translate(region.cx * w, region.cy * h);
    mctx.scale(rx * w, ry * h);
    const outer = 1 + f;
    const g = mctx.createRadialGradient(0, 0, 0, 0, 0, outer);
    // alpha = clamp((1 + f - r) / f, 0, 1): flat 1 up to r = 1, linear to 0 at 1 + f
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(Math.min(0.999999, 1 / outer), 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = g;
    mctx.beginPath();
    mctx.arc(0, 0, outer, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
    this.maskKey = key;
    return this.maskCanvas;
  }

  /** Start the rAF render loop. */
  play(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    const animate = async (timestamp: number): Promise<void> => {
      if (!this.isPlaying) return;
      if (this.animationController) {
        const frameIndex = this.animationController.getNextFrame(timestamp);
        if (frameIndex >= 0) {
          const warp = this.animationController.getMocapWarp(this.canvas.width, this.canvas.height, timestamp);
          if (warp) await this.renderMocapFrame(frameIndex, warp);
          else await this.renderFrame(frameIndex);
        }
      }
      this.animationFrame = requestAnimationFrame(animate);
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  /** Stop the render loop (the last frame stays painted). */
  stop(): void {
    this.isPlaying = false;
    if (this.animationFrame != null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  isRunning(): boolean {
    return this.isPlaying;
  }

  setTalkingState(talking: boolean): void {
    this.animationController?.setTalkingState(talking);
  }

  /** Release cached frame images. */
  dispose(): void {
    this.stop();
    this.frameImages.clear();
    this.lastRenderedFrame = -1;
    this.warpCanvas = null;
    this.warpCtx = null;
    this.maskCanvas = null;
    this.maskCtx = null;
    this.maskKey = '';
  }
}

/**
 * Build a normalized {@link AnimationControllerConfig} from the avatar file's
 * raw camelCase `animation` block.
 */
export function buildControllerConfig(data: AniaAvatarData): AnimationControllerConfig {
  const frameCount = data.video?.frames?.length || 0;
  const a = data.animation || {};
  return {
    idle_range_low: Math.floor(a.idleRangeLowValue || 0),
    idle_range_high: Math.floor(a.idleRangeHighValue || Math.floor(frameCount / 2)),
    talk_range_low: Math.floor(a.talkRangeLowValue || Math.floor(frameCount / 2)),
    talk_range_high: Math.floor(a.talkRangeHighValue || Math.max(0, frameCount - 1)),
    idle_speed_slider_value: a.idleSpeedSliderValue || 1,
    talk_speed_slider_value: a.talkSpeedSliderValue || 1,
    current_frame_index: a.currentFrameIndex || 0,
    idle_start_positions: a.idleStartPositions || [],
    talk_start_positions: a.talkStartPositions || [],
    reverse_idle_selected: a.reverseIdleSelected || false,
    reverse_talk_selected: a.reverseTalkSelected || false,
  };
}
