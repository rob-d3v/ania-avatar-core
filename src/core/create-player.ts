// createAniaPlayer — the high-level imperative API.
//
// Mounts an avatar player onto a <canvas> (or a container, in which case a
// <canvas> is created inside it) and exposes load / play / pause / talking /
// actions / lip-sync controls plus a typed event emitter. Wrapper libraries
// (Vue/Angular/Svelte/Web-Component) bind their reactive props/events to this.

import { AniaPlayer, buildControllerConfig } from './ania-player';
import { AnimationController } from './animation-controller';
import { Emitter } from './emitter';
import { decryptAniaFile } from '../crypto/ania-crypto';
import { calcSpeeds } from '../utils/speed-calculator';
import {
  buildOpennessMap,
  fetchActionsConfig,
  fetchLipSyncConfig,
} from '../services/avatar-config-api';
import type {
  ActionConfig,
  ActionInfo,
  AniaAvatarData,
  AniaPlayerInstance,
  LipSyncSustainStyle,
  LoadSource,
  MocapComfortInput,
  MocapConfigureInput,
  SmoothCutConfigureInput,
  PlayerEventMap,
  PlayerEventName,
  PlayerOptions,
} from '../types';
import type { PoseDescriptorMessage } from '../motion-matcher';

const isCanvas = (el: Element): el is HTMLCanvasElement =>
  el.tagName === 'CANVAS' || el instanceof HTMLCanvasElement;

/**
 * Create an avatar player on `target`.
 *
 * @param target A `<canvas>` to render into, or any element to create a canvas inside.
 * @param options See {@link PlayerOptions}.
 */
export function createAniaPlayer(
  target: HTMLCanvasElement | HTMLElement,
  options: PlayerOptions = {}
): AniaPlayerInstance {
  const logger = options.logger || console;
  const emitter = new Emitter<PlayerEventMap>();

  // Resolve the canvas (create one if a container was passed).
  let createdCanvas = false;
  let canvas: HTMLCanvasElement;
  if (isCanvas(target)) {
    canvas = target;
  } else {
    canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    target.appendChild(canvas);
    createdCanvas = true;
  }

  const width = options.width ?? canvas.width ?? 200;
  const height = options.height ?? canvas.height ?? 200;

  const player = new AniaPlayer(canvas, { width, height });
  let controller: AnimationController | null = null;
  let loadedActions: ActionConfig[] = [];
  let opennessFn: (() => number) | null = null;

  // ---- Helpers ----

  const wireControllerCallbacks = (c: AnimationController): void => {
    c.onActionStartCallback = (id) => emitter.emit('actionStart', id);
    c.onActionCompleteCallback = (id) => emitter.emit('actionEnd', id);
    c.onActionCancelCallback = (id) => emitter.emit('actionEnd', id);
    c.onMocapGapCallback = (gapOpen, emaError) => emitter.emit('mocapGap', { gapOpen, emaError });
  };

  const applyInitialLipSync = (c: AnimationController): void => {
    const lip = options.lipSync;
    if (lip?.enabled) {
      c.configureLipsSync(
        true,
        lip.intensity ?? 0.6,
        lip.responsiveness ?? 0.5,
        lip.opennessMap ?? null,
        lip.sustainStyle ?? 'wiggle',
        lip.wiggleSpeed ?? 2
      );
    }
  };

  const setupController = (data: AniaAvatarData): void => {
    const frameCount = data.video?.frames?.length || 0;
    const cfg = buildControllerConfig(data);

    if (options.autoCalculateSpeed && data.video?.fps) {
      const s = calcSpeeds(data.video.fps);
      cfg.idle_speed_slider_value = options.idleSpeed ?? s.idle;
      cfg.talk_speed_slider_value = options.talkSpeed ?? s.talk;
    } else {
      if (options.idleSpeed != null) cfg.idle_speed_slider_value = options.idleSpeed;
      if (options.talkSpeed != null) cfg.talk_speed_slider_value = options.talkSpeed;
    }

    controller = new AnimationController(cfg, frameCount);
    controller.getOpennessFn = () => (opennessFn ? opennessFn() : 0);
    wireControllerCallbacks(controller);
    applyInitialLipSync(controller);

    player.fileData = data;
    player.animationController = controller;

    // Embedded actions.
    loadedActions = Array.isArray(data.actions) ? [...data.actions] : [];
    controller.configureActions(loadedActions);
  };

  // Fetch server-side actions + lip-sync config (best-effort) after load.
  const fetchServerConfig = async (data: AniaAvatarData): Promise<void> => {
    if (!options.serverUrl || !data.contentHash || !controller) return;
    const cfg = buildControllerConfig(data);

    if (options.fetchActionsFromServer) {
      try {
        const serverActions = await fetchActionsConfig(options.serverUrl, data.contentHash);
        if (serverActions && serverActions.length > 0) {
          const byId = new Map(loadedActions.map((a) => [a.id, a]));
          for (const sa of serverActions) byId.set(sa.id, sa);
          loadedActions = Array.from(byId.values());
          controller.configureActions(loadedActions);
        }
      } catch (err) {
        logger.warn('[ania-avatar-core] actions config fetch failed:', err);
      }
    }

    if (options.lipSync?.enabled) {
      try {
        const lipConfig = await fetchLipSyncConfig(options.serverUrl, data.contentHash);
        if (lipConfig) {
          const talkLow = cfg.talk_range_low ?? 0;
          const talkHigh = cfg.talk_range_high ?? 0;
          const opennessMap = lipConfig.lips_sync_keyframes
            ? buildOpennessMap(lipConfig.lips_sync_keyframes, talkLow, talkHigh)
            : options.lipSync.opennessMap ?? null;
          controller.configureLipsSync(
            true,
            lipConfig.lips_sync_sync_intensity ?? options.lipSync.intensity ?? 0.6,
            lipConfig.lips_sync_responsiveness ?? options.lipSync.responsiveness ?? 0.5,
            opennessMap,
            lipConfig.lips_sync_sustain_style ?? options.lipSync.sustainStyle ?? 'wiggle',
            lipConfig.lips_sync_wiggle_speed ?? options.lipSync.wiggleSpeed ?? 2
          );
        }
      } catch (err) {
        logger.warn('[ania-avatar-core] lip-sync config fetch failed:', err);
      }
    }
  };

  // ---- Public API ----

  const instance: AniaPlayerInstance = {
    async load(source) {
      try {
        let data: AniaAvatarData;

        // 1) Raw avatar data passed directly (object with video.frames).
        if (
          source &&
          typeof source === 'object' &&
          'video' in source &&
          (source as AniaAvatarData).video
        ) {
          data = source as AniaAvatarData;
        } else {
          const src = source as LoadSource;
          if (src.data) {
            data = src.data;
          } else if (src.url) {
            const headers: Record<string, string> = {};
            if (src.authToken) headers.Authorization = `Bearer ${src.authToken}`;
            const res = await fetch(src.url, { headers });
            if (!res.ok) throw new Error(`Failed to fetch avatar: HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            // Heuristic: ANIA-magic binary => decrypt; otherwise treat as JSON.
            const head = new Uint8Array(buf.slice(0, 4));
            const isAnia = String.fromCharCode(...head) === 'ANIA';
            data = isAnia
              ? await decryptAniaFile(buf, src.password || '')
              : (JSON.parse(new TextDecoder().decode(buf)) as AniaAvatarData);
          } else {
            throw new Error('load() requires { url } or { data } (or raw AniaAvatarData).');
          }
        }

        setupController(data);
        void fetchServerConfig(data);

        if (options.autoplay !== false) player.play();
        emitter.emit('load', data);
        return data;
      } catch (err) {
        emitter.emit('error', err as Error);
        throw err;
      }
    },

    play() {
      player.play();
    },

    pause() {
      player.stop();
    },

    destroy() {
      player.dispose();
      emitter.clear();
      controller = null;
      if (createdCanvas && canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
    },

    setTalking(talking) {
      const was = controller?.isTalking ?? false;
      controller?.setTalkingState(talking);
      if (talking && !was) emitter.emit('talkStart', undefined);
      else if (!talking && was) emitter.emit('talkEnd', undefined);
    },

    triggerAction(id) {
      return controller?.triggerAction(id) ?? false;
    },

    cancelAction(force) {
      controller?.cancelAction(force);
    },

    configureActions(actions) {
      loadedActions = [...actions];
      controller?.configureActions(loadedActions);
    },

    configureLipsSync(enabled, intensity, responsiveness, opennessMap, sustainStyle, wiggleSpeed) {
      controller?.configureLipsSync(
        enabled,
        intensity,
        responsiveness,
        opennessMap ?? null,
        (sustainStyle as LipSyncSustainStyle) ?? 'wiggle',
        wiggleSpeed
      );
    },

    getAvailableActions(): ActionInfo[] {
      return loadedActions.map((a) => ({ id: a.id, name: a.name }));
    },

    setOpennessSource(fn) {
      opennessFn = fn;
    },

    setSpeeds(idleSpeed, talkSpeed) {
      controller?.setSpeeds(idleSpeed, talkSpeed);
    },

    configureMocap(index: MocapConfigureInput | null) {
      return controller?.configureMocap(index) ?? false;
    },

    pushPose(desc: PoseDescriptorMessage) {
      controller?.pushPose(desc);
    },

    setMocapEnabled(enabled) {
      controller?.setMocapEnabled(enabled);
    },

    setMocapLevel(level: string) {
      return controller?.setMocapLevel(level) ?? 'off';
    },

    setMocapComfort(comfort: MocapComfortInput) {
      return controller?.setMocapComfort(comfort) ?? null;
    },

    setMouthSource(source: string) {
      return controller?.setMouthSource(source) ?? 'audio';
    },

    pushMicOpenness(value: number | null, atMs?: number) {
      controller?.pushMicOpenness(value, atMs);
    },

    getMocapCapabilities() {
      return (
        controller?.getMocapCapabilities() ?? {
          caps: {},
          level: 'off',
          requestedLevel: 'off',
          blocked: false,
          active: false,
          canBlend: true,
          crossfade: 'auto' as const,
          channels: [],
          missingChannels: [],
          warnings: [],
          comfort: null,
        }
      );
    },

    isMocapActive() {
      return controller?.isMocapActive() ?? false;
    },

    getMocapMode() {
      return controller?.getMocapMode() ?? null;
    },

    configureSmoothCut(config: SmoothCutConfigureInput | null) {
      return controller?.configureSmoothCut(config) ?? false;
    },
    getMocapDebug() {
      return controller?.getMocapDebug() ?? null;
    },

    getMocapResidual() {
      return controller?.getMocapResidual() ?? null;
    },

    get controller() {
      return controller;
    },

    get canvas() {
      return canvas;
    },

    on<E extends PlayerEventName>(event: E, cb: (payload: PlayerEventMap[E]) => void) {
      return emitter.on(event, cb);
    },

    off<E extends PlayerEventName>(event: E, cb: (payload: PlayerEventMap[E]) => void) {
      emitter.off(event, cb);
    },
  };

  return instance;
}
