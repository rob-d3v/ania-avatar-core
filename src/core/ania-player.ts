// AniaPlayer — the framework-free canvas renderer + frame loop.
//
// Extracted from the Chrome extension content-script's embedded `AniaPlayer`,
// with ALL extension/DOM-menu/drag UI removed. It owns a <canvas>, decodes the
// avatar's base64 WebP frames into Image objects (cached), and on each rAF tick
// asks the AnimationController which frame to draw.

import { AnimationController } from './animation-controller';
import type { AnimationControllerConfig, AniaAvatarData } from '../types';

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

  /** Start the rAF render loop. */
  play(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    const animate = async (timestamp: number): Promise<void> => {
      if (!this.isPlaying) return;
      if (this.animationController) {
        const frameIndex = this.animationController.getNextFrame(timestamp);
        if (frameIndex >= 0) await this.renderFrame(frameIndex);
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
