// PluginRegistry — runtime registry for Ania avatar plugins.
//
// Plugins of kind 'tts' | 'stt' | 'wakeword' | 'action' | 'integration' are
// registered, one provider per subsystem is marked "active", and hosts resolve
// the active engine/handler on demand. Framework-agnostic (plain class).
//
// Ported from the web-player's `plugins/plugin-registry.js`.

import { PLUGIN_KINDS } from '../types';
import type {
  Plugin,
  PluginContext,
  PluginKind,
  STTEngine,
  TTSEngine,
  WakeWordEngineLike,
} from '../types';

/** Throws if `plugin` doesn't satisfy the minimum contract; returns it otherwise. */
export const validatePlugin = (plugin: Plugin): Plugin => {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error('[PluginRegistry] plugin must be an object');
  }
  if (!plugin.id || typeof plugin.id !== 'string') {
    throw new Error('[PluginRegistry] plugin.id is required (string)');
  }
  if (!PLUGIN_KINDS.includes(plugin.kind)) {
    throw new Error(
      `[PluginRegistry] plugin.kind must be one of ${PLUGIN_KINDS.join(', ')} (got "${plugin.kind}")`
    );
  }
  return plugin;
};

type RegistryListener = (registry: PluginRegistry) => void;

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private active: Partial<Record<PluginKind, string | undefined>> = {};
  private initialized = new Set<string>();
  private listeners = new Set<RegistryListener>();
  public logger: Pick<Console, 'log' | 'warn' | 'error'> = console;

  /** Subscribe to registry changes. Returns an unsubscribe fn. */
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this);
      } catch {
        /* listener errors must not break the registry */
      }
    }
  }

  /**
   * Register a plugin. The first registered provider of a tts/stt/wakeword kind
   * becomes the active provider for that kind unless one is already active.
   * @returns an unregister fn for this plugin.
   */
  register(plugin: Plugin): () => void {
    validatePlugin(plugin);
    const normalized: Plugin = { enabled: true, builtin: false, version: '0.0.0', ...plugin };
    this.plugins.set(normalized.id, normalized);

    if (
      (normalized.kind === 'tts' || normalized.kind === 'stt' || normalized.kind === 'wakeword') &&
      !this.active[normalized.kind] &&
      normalized.enabled !== false
    ) {
      this.active[normalized.kind] = normalized.id;
    }
    this.emit();
    return () => this.unregister(normalized.id);
  }

  /** Register many plugins at once. */
  registerAll(plugins: Plugin[] = []): void {
    plugins.forEach((p) => this.register(p));
  }

  /** Remove a plugin by id. Clears/re-selects the active slot if it pointed here. */
  unregister(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    this.plugins.delete(id);
    this.initialized.delete(id);
    if (this.active[plugin.kind] === id) {
      const next = this.getByKind(plugin.kind).find((p) => p.enabled !== false);
      this.active[plugin.kind] = next ? next.id : undefined;
    }
    this.emit();
  }

  get(id: string): Plugin | null {
    return this.plugins.get(id) || null;
  }

  /** All registered plugins (insertion order). */
  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /** All plugins of a given kind. */
  getByKind(kind: PluginKind): Plugin[] {
    return this.list().filter((p) => p.kind === kind);
  }

  /** Enable/disable a plugin. Disabling the active provider re-selects. */
  setEnabled(id: string, enabled: boolean): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.enabled = enabled;
    if (!enabled && this.active[plugin.kind] === id) {
      const next = this.getByKind(plugin.kind).find((p) => p.id !== id && p.enabled !== false);
      this.active[plugin.kind] = next ? next.id : undefined;
    } else if (
      enabled &&
      !this.active[plugin.kind] &&
      (plugin.kind === 'tts' || plugin.kind === 'stt' || plugin.kind === 'wakeword')
    ) {
      this.active[plugin.kind] = id;
    }
    this.emit();
  }

  /** Mark which provider is active for a subsystem. */
  setActive(kind: PluginKind, id: string): void {
    if (!PLUGIN_KINDS.includes(kind)) {
      throw new Error(`[PluginRegistry] unknown kind "${kind}"`);
    }
    if (id != null && !this.plugins.has(id)) {
      this.logger.warn(`[PluginRegistry] setActive("${kind}", "${id}") — plugin not registered`);
    }
    this.active[kind] = id;
    this.emit();
  }

  /** Id of the active provider for a kind (or null). */
  getActiveId(kind: PluginKind): string | null {
    return this.active[kind] || null;
  }

  /** The active provider plugin for a kind (or null). */
  getActive(kind: PluginKind): Plugin | null {
    const id = this.active[kind];
    return id ? this.plugins.get(id) || null : null;
  }

  /** Ensure a plugin's init() has run exactly once, then return the plugin. */
  async ensureInit(id: string, ctx: PluginContext = {}): Promise<Plugin | null> {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    if (!this.initialized.has(id) && typeof plugin.init === 'function') {
      await plugin.init({ registry: this, logger: this.logger, ...ctx });
      this.initialized.add(id);
    }
    return plugin;
  }

  /** Resolve the active engine for a tts/stt/wakeword subsystem. */
  async resolveEngine(
    kind: 'tts' | 'stt' | 'wakeword',
    ctx: PluginContext = {}
  ): Promise<TTSEngine | STTEngine | WakeWordEngineLike | null> {
    const plugin = this.getActive(kind);
    if (!plugin) return null;
    await this.ensureInit(plugin.id, ctx);
    if (typeof plugin.createEngine !== 'function') return null;
    return plugin.createEngine({ registry: this, logger: this.logger, ...ctx }) as
      | TTSEngine
      | STTEngine
      | WakeWordEngineLike;
  }

  /** Resolve handlers for all enabled action/integration plugins of a kind. */
  async resolveHandlers(
    kind: 'action' | 'integration',
    ctx: PluginContext = {}
  ): Promise<Array<{ id: string; handler: unknown }>> {
    const out: Array<{ id: string; handler: unknown }> = [];
    for (const plugin of this.getByKind(kind)) {
      if (plugin.enabled === false) continue;
      await this.ensureInit(plugin.id, ctx);
      if (typeof plugin.createHandler === 'function') {
        out.push({ id: plugin.id, handler: plugin.createHandler({ registry: this, logger: this.logger, ...ctx }) });
      }
    }
    return out;
  }

  /** Start every enabled plugin that exposes start(). */
  async startAll(ctx: PluginContext = {}): Promise<void> {
    for (const plugin of this.list()) {
      if (plugin.enabled === false) continue;
      await this.ensureInit(plugin.id, ctx);
      if (typeof plugin.start === 'function') await plugin.start();
    }
  }

  /** Stop every plugin that exposes stop(). */
  async stopAll(): Promise<void> {
    for (const plugin of this.list()) {
      if (typeof plugin.stop === 'function') {
        try {
          await plugin.stop();
        } catch (e) {
          this.logger.warn(`[PluginRegistry] stop("${plugin.id}") failed:`, e);
        }
      }
    }
  }
}

/** Shared default registry instance (built-ins are registered onto it). */
let defaultRegistry: PluginRegistry | null = null;
export const getDefaultRegistry = (): PluginRegistry => {
  if (!defaultRegistry) defaultRegistry = new PluginRegistry();
  return defaultRegistry;
};
