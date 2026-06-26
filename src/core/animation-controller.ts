// Animation controller for the Ania avatar.
//
// Drives idle/talk frame cycling plus:
//   - an actions system (play a frame sub-range at a speed/direction, optionally
//     from a random start position, then resume idle/talk)
//   - advanced openness-driven lip-sync (intensity / responsiveness / sustain /
//     wiggle + an openness->frame map)
//
// Framework-free. Ported from the Chrome extension's
// `lib/core/animation-controller.ts`.

import type {
  ActionConfig,
  AnimationControllerConfig,
  LipSyncSustainStyle,
} from '../types';

interface ActiveAction {
  config: ActionConfig;
  frame: number;
  direction: number;
  low: number;
  high: number;
  speed: number;
}

export class AnimationController {
  private config: AnimationControllerConfig;
  private currentFrameIndex: number;
  private idleSpeed: number;
  private talkSpeed: number;
  private lastFrameTime = 0;
  private frameInterval = 1000 / 30; // target 30fps playback
  private direction = 1; // 1 = forward, -1 = reverse
  public isTalking = false;

  // ----- Actions -----
  private actions = new Map<string, ActionConfig>();
  private activeAction: ActiveAction | null = null;
  /** Fired when an action starts. */
  public onActionStartCallback: ((id: string) => void) | null = null;
  /** Fired when an action completes naturally (reached the range end). */
  public onActionCompleteCallback: ((id: string) => void) | null = null;
  /** Fired when an action is force-cancelled. */
  public onActionCancelCallback: ((id: string) => void) | null = null;

  // ----- Lip sync -----
  private lipSyncEnabled = false;
  private lipSyncIntensity = 0.6;
  private lipSyncResponsiveness = 0.5;
  private lipSyncSustainStyle: LipSyncSustainStyle = 'wiggle';
  private lipSyncWiggleSpeed = 2;
  private opennessMap: number[] | null = null;
  private envelope = 0; // smoothed openness 0..1
  private wigglePhase = 0;
  /** Supplied by the audio path each frame; returns instantaneous openness 0..1. */
  public getOpennessFn: (() => number) | null = null;

  constructor(config: AnimationControllerConfig, frameCount: number) {
    this.config = config;
    this.currentFrameIndex = config.current_frame_index || 0;

    this.idleSpeed = config.idle_speed_slider_value || 1;
    this.talkSpeed = config.talk_speed_slider_value || 1;

    if (this.config.idle_range_low === undefined) this.config.idle_range_low = 0;
    if (this.config.idle_range_high === undefined)
      this.config.idle_range_high = Math.floor(frameCount / 2);
    if (this.config.talk_range_low === undefined)
      this.config.talk_range_low = Math.floor(frameCount / 2);
    if (this.config.talk_range_high === undefined)
      this.config.talk_range_high = Math.max(0, frameCount - 1);

    this.jumpToRandomStartPosition(false);
  }

  // ===== Mode / idle-talk cycling =====

  private jumpToRandomStartPosition(talking: boolean): void {
    const positions = talking
      ? this.config.talk_start_positions
      : this.config.idle_start_positions;

    if (positions && positions.length > 0) {
      const randomIndex = Math.floor(Math.random() * positions.length);
      this.currentFrameIndex = positions[randomIndex];
    } else {
      const range = talking
        ? { low: this.config.talk_range_low!, high: this.config.talk_range_high! }
        : { low: this.config.idle_range_low!, high: this.config.idle_range_high! };
      this.currentFrameIndex = range.low;
    }

    const useReverse = talking
      ? this.config.reverse_talk_selected
      : this.config.reverse_idle_selected;
    this.direction = useReverse ? -1 : 1;
  }

  setTalkingState(talking: boolean): void {
    if (this.isTalking !== talking) {
      this.isTalking = talking;
      if (!talking) this.envelope = 0;
      // Don't reposition mid-action; the action owns the frame cursor.
      if (!this.activeAction) this.jumpToRandomStartPosition(talking);
    }
  }

  setSpeeds(idleSpeed?: number, talkSpeed?: number): void {
    if (typeof idleSpeed === 'number' && idleSpeed > 0) this.idleSpeed = idleSpeed;
    if (typeof talkSpeed === 'number' && talkSpeed > 0) this.talkSpeed = talkSpeed;
  }

  /** Set the idle animation speed multiplier. */
  setIdleSpeed(speed: number): void {
    if (speed > 0) this.idleSpeed = speed;
  }

  /** Set the talk animation speed multiplier. */
  setTalkSpeed(speed: number): void {
    if (speed > 0) this.talkSpeed = speed;
  }

  // ===== Actions =====

  /** Register the available actions (replaces any prior set). */
  configureActions(actions: ActionConfig[] | undefined): void {
    this.actions.clear();
    if (!actions) return;
    for (const a of actions) {
      if (a && a.id) this.actions.set(a.id, a);
    }
  }

  getActions(): ActionConfig[] {
    return Array.from(this.actions.values());
  }

  hasAction(id: string): boolean {
    return this.actions.has(id);
  }

  /** Begin playing an action by id. Returns true if the action exists. */
  triggerAction(actionId: string): boolean {
    const config = this.actions.get(actionId);
    if (!config) return false;

    const low = Math.min(config.range_low, config.range_high);
    const high = Math.max(config.range_low, config.range_high);

    let frame = low;
    if (config.start_positions && config.start_positions.length > 0) {
      const idx = Math.floor(Math.random() * config.start_positions.length);
      frame = Math.max(low, Math.min(high, config.start_positions[idx]));
    } else if (config.reverse) {
      frame = high;
    }

    this.activeAction = {
      config,
      frame,
      direction: config.reverse ? -1 : 1,
      low,
      high,
      speed: config.speed && config.speed > 0 ? config.speed : 1,
    };
    this.currentFrameIndex = frame;
    this.onActionStartCallback?.(actionId);
    return true;
  }

  /**
   * Cancel the active action. With `force`, fires the cancel callback;
   * otherwise it's treated as a natural completion.
   */
  cancelAction(force = false): void {
    if (!this.activeAction) return;
    const id = this.activeAction.config.id;
    this.activeAction = null;
    this.jumpToRandomStartPosition(this.isTalking);
    if (force) this.onActionCancelCallback?.(id);
    else this.onActionCompleteCallback?.(id);
  }

  isActionPlaying(): boolean {
    return this.activeAction !== null;
  }

  // ===== Lip sync =====

  /**
   * Configure the advanced lip-sync. `opennessMap` maps a talk-range frame
   * offset to an openness value 0..1 (built via {@link buildOpennessMap}).
   */
  configureLipsSync(
    enabled: boolean,
    intensity = 0.6,
    responsiveness = 0.5,
    opennessMap: number[] | null = null,
    sustainStyle: LipSyncSustainStyle = 'wiggle',
    wiggleSpeed = 2
  ): void {
    this.lipSyncEnabled = enabled;
    this.lipSyncIntensity = Math.max(0, Math.min(1, intensity));
    this.lipSyncResponsiveness = Math.max(0.05, Math.min(1, responsiveness));
    this.lipSyncSustainStyle = sustainStyle;
    this.lipSyncWiggleSpeed = Math.max(1, Math.min(6, wiggleSpeed));
    this.opennessMap = opennessMap && opennessMap.length > 0 ? opennessMap : null;
    if (!enabled) this.envelope = 0;
  }

  isLipSyncEnabled(): boolean {
    return this.lipSyncEnabled;
  }

  getLipSyncEnvelope(): number {
    return this.envelope;
  }

  /**
   * Pick the talk-range frame whose mapped openness is closest to the target.
   * Falls back to linear interpolation across the talk range when no map.
   */
  private frameForOpenness(openness: number): number {
    const low = this.config.talk_range_low!;
    const high = this.config.talk_range_high!;
    if (high <= low) return low;

    if (this.opennessMap && this.opennessMap.length > 0) {
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < this.opennessMap.length; i++) {
        const diff = Math.abs(this.opennessMap[i] - openness);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      return Math.max(low, Math.min(high, low + bestIdx));
    }

    // No map: linear — louder => later (more-open) frame in the talk range.
    return Math.round(low + openness * (high - low));
  }

  // ===== Per-frame tick =====

  /**
   * Advance the animation. Returns the frame index to render, or -1 if it's
   * not yet time to update (throttled by speed). Call from a rAF loop with the
   * timestamp.
   */
  getNextFrame(timestamp: number): number {
    // --- Active action takes priority ---
    if (this.activeAction) {
      const adjustedInterval = this.frameInterval / this.activeAction.speed;
      if (timestamp - this.lastFrameTime < adjustedInterval) return -1;
      this.lastFrameTime = timestamp;

      const a = this.activeAction;
      a.frame += a.direction;
      if (a.frame > a.high || a.frame < a.low) {
        this.cancelAction(false);
        return Math.floor(this.currentFrameIndex);
      }
      this.currentFrameIndex = a.frame;
      return Math.floor(a.frame);
    }

    // --- Advanced lip-sync (only while talking) ---
    if (this.lipSyncEnabled && this.isTalking && this.getOpennessFn) {
      const adjustedInterval = this.frameInterval / this.talkSpeed;
      if (timestamp - this.lastFrameTime < adjustedInterval) return -1;
      this.lastFrameTime = timestamp;

      const raw = Math.max(0, Math.min(1, this.getOpennessFn()));
      const boosted = Math.min(1, raw * (1 + this.lipSyncIntensity));
      this.envelope += (boosted - this.envelope) * this.lipSyncResponsiveness;

      let openness = this.envelope;
      if (this.lipSyncSustainStyle === 'wiggle' && this.envelope > 0.15) {
        this.wigglePhase += 0.15 * this.lipSyncWiggleSpeed;
        const wiggle = Math.sin(this.wigglePhase) * 0.15 * this.envelope;
        openness = Math.max(0, Math.min(1, this.envelope + wiggle));
      }

      const frame = this.frameForOpenness(openness);
      this.currentFrameIndex = frame;
      return Math.floor(frame);
    }

    // --- Standard idle/talk cycling ---
    const speed = this.isTalking ? this.talkSpeed : this.idleSpeed;
    const adjustedInterval = this.frameInterval / speed;
    if (timestamp - this.lastFrameTime < adjustedInterval) return -1;
    this.lastFrameTime = timestamp;

    const range = this.isTalking
      ? { low: this.config.talk_range_low!, high: this.config.talk_range_high! }
      : { low: this.config.idle_range_low!, high: this.config.idle_range_high! };

    this.currentFrameIndex += this.direction;

    if (this.currentFrameIndex >= range.high) {
      if (this.config.reverse_idle_selected || this.config.reverse_talk_selected) {
        this.direction = -1;
        this.currentFrameIndex = range.high - 1;
      } else {
        this.currentFrameIndex = range.low;
      }
    } else if (this.currentFrameIndex < range.low) {
      if (this.config.reverse_idle_selected || this.config.reverse_talk_selected) {
        this.direction = 1;
        this.currentFrameIndex = range.low + 1;
      } else {
        this.currentFrameIndex = range.high - 1;
      }
    }

    return Math.floor(this.currentFrameIndex);
  }
}
