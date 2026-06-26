// Command / external-control API — port of the desktop Ania Player socket
// command set. `executeCommand(line, ctx)` parses a single command line and
// drives the avatar through the supplied {@link CommandContext}.
//
// Supported verbs: show / hide / toggle / action / actions / info / speed /
// sensitivity / mute / unmute / tts / ask (alias: provider) / wake / stop / help.
//
// Framework-free; merged from the web-player `utils/commands.js` (rich ctx) and
// the Chrome extension's `lib/core/commands.ts`.

import type {
  ActionInfo,
  CommandContext,
  CommandDescriptor,
  CommandResult,
} from '../types';

export const COMMAND_LIST: CommandDescriptor[] = [
  { cmd: 'show', desc: 'Show the avatar (resume animation).' },
  { cmd: 'hide', desc: 'Hide the avatar (pause animation).' },
  { cmd: 'toggle', desc: 'Toggle avatar visibility.' },
  { cmd: 'action <id|index>', desc: 'Trigger an action by id or 1-based position.' },
  { cmd: 'actions', desc: 'List available actions (index, id, name).' },
  { cmd: 'info', desc: 'Report player info (visible, talking, action list).' },
  { cmd: 'speed <idle> [talk]', desc: 'Set idle (and optional talk) speed. talk defaults to idle.' },
  { cmd: 'sensitivity <0..1>', desc: 'Set microphone / lip-sync sensitivity.' },
  { cmd: 'mute', desc: 'Mute microphone / output.' },
  { cmd: 'unmute', desc: 'Unmute microphone / output.' },
  { cmd: 'tts <text>', desc: 'Speak literal text via TTS (no LLM).' },
  { cmd: 'ask <text>', desc: 'Send text to the chatbot/LLM; reply is spoken.' },
  { cmd: 'provider <text>', desc: 'Alias of "ask".' },
  { cmd: 'wake', desc: 'Trigger the wake/assistant pipeline manually.' },
  { cmd: 'stop', desc: 'Stop speaking / listening.' },
  { cmd: 'help', desc: 'List all commands.' },
];

const helpText = (): string =>
  'Commands:\n' + COMMAND_LIST.map((c) => `  ${c.cmd.padEnd(22)} ${c.desc}`).join('\n');

/** Split a command line into `{ verb, args, rest }`, honoring quotes. */
export const parseCommandLine = (
  line: string
): { verb: string; args: string[]; rest: string } => {
  const trimmed = String(line || '').trim();
  if (!trimmed) return { verb: '', args: [], rest: '' };
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  const verb = (match ? match[1] : trimmed).toLowerCase();
  const rest = match ? match[2] : '';
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return { verb, args, rest: rest.trim() };
};

const resolveActionId = (actions: ActionInfo[], token: string): string | null => {
  if (!actions || actions.length === 0) return null;
  const byId = actions.find((a) => a.id === token);
  if (byId) return byId.id;
  const idx = parseInt(token, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= actions.length) return actions[idx - 1].id;
  return null;
};

/**
 * Execute one command line against `ctx`. Synchronous (handlers may be async
 * but their result is not awaited here). Returns `{ ok, message, data? }`.
 */
export const executeCommand = (line: string, ctx: CommandContext = {}): CommandResult => {
  const logger = ctx.logger || console;
  const { verb, args, rest } = parseCommandLine(line);
  const ok = (message: string, data?: unknown): CommandResult => ({ ok: true, message, data });
  const err = (message: string): CommandResult => ({ ok: false, message });

  try {
    switch (verb) {
      case '':
        return err('Empty command. Try "help".');

      case 'show':
        ctx.setVisible?.(true);
        ctx.player?.play?.();
        return ok('Avatar shown.');

      case 'hide':
        ctx.setVisible?.(false);
        ctx.player?.pause?.();
        return ok('Avatar hidden.');

      case 'toggle': {
        const current = ctx.getVisible ? ctx.getVisible() : true;
        const next = !current;
        ctx.setVisible?.(next);
        if (next) ctx.player?.play?.();
        else ctx.player?.pause?.();
        return ok(`Avatar ${next ? 'shown' : 'hidden'}.`);
      }

      case 'action': {
        const actions = ctx.getActions ? ctx.getActions() : [];
        if (!args[0]) return err('Usage: action <id|index>');
        const id = resolveActionId(actions, args[0]);
        if (!id) return err(`No action matches "${args[0]}".`);
        ctx.triggerAction?.(id);
        return ok(`Action "${id}" triggered.`, { id });
      }

      case 'actions': {
        const actions = ctx.getActions ? ctx.getActions() : [];
        const data = actions.map((a, i) => ({ index: i + 1, id: a.id, name: a.name }));
        const msg = data.length
          ? data.map((a) => `${a.index}) ${a.name} — id=${a.id}`).join('\n')
          : 'No actions available.';
        return ok(msg, data);
      }

      case 'info': {
        const actions = ctx.getActions ? ctx.getActions() : [];
        const controller = (ctx.player as { controller?: { isTalking?: boolean } } | undefined)
          ?.controller;
        const info = {
          visible: ctx.getVisible ? ctx.getVisible() : undefined,
          talking: controller ? !!controller.isTalking : undefined,
          actions: actions.map((a, i) => ({ index: i + 1, id: a.id, name: a.name })),
        };
        ctx.onInfo?.(info);
        return ok('Player info.', info);
      }

      case 'speed': {
        if (!args[0]) return err('Usage: speed <idle> [talk]');
        const idle = parseFloat(args[0]);
        if (Number.isNaN(idle)) return err('Invalid idle speed.');
        const talk =
          args[1] != null && !Number.isNaN(parseFloat(args[1])) ? parseFloat(args[1]) : idle;
        ctx.setSpeeds?.(idle, talk);
        return ok(`Speed set: idle=${idle}, talk=${talk}.`, { idle, talk });
      }

      case 'sensitivity': {
        const v = parseFloat(args[0]);
        if (Number.isNaN(v)) return err('Usage: sensitivity <0..1>');
        const clamped = Math.max(0, Math.min(1, v));
        ctx.setSensitivity?.(clamped);
        return ok(`Sensitivity set to ${clamped}.`, { sensitivity: clamped });
      }

      case 'mute':
        ctx.setMuted?.(true);
        return ok('Muted.');

      case 'unmute':
        ctx.setMuted?.(false);
        return ok('Unmuted.');

      case 'tts': {
        if (!rest) return err('Usage: tts <text>');
        if (!ctx.speak) return err('No TTS handler wired.');
        ctx.speak(rest, { cancelPrevious: true });
        return ok('Speaking.', { text: rest });
      }

      case 'ask':
      case 'provider': {
        if (!rest) return err(`Usage: ${verb} <text>`);
        if (!ctx.ask) return err('No chatbot/LLM handler wired.');
        void ctx.ask(rest);
        return ok('Asked.', { text: rest });
      }

      case 'wake':
      case 'assistant':
        if (!ctx.triggerWake) return err('No wake handler wired.');
        ctx.triggerWake();
        return ok('Wake pipeline triggered.');

      case 'stop':
        ctx.stopSpeaking?.();
        return ok('Stopped.');

      case 'help':
        return ok(helpText(), COMMAND_LIST);

      default:
        return err(`Unknown command "${verb}". Try "help".`);
    }
  } catch (e) {
    logger.warn('[commands] executeCommand failed:', e);
    const msg = e && (e as Error).message ? (e as Error).message : String(e);
    return err(`Command error: ${msg}`);
  }
};

/**
 * Install an origin-allowlisted `window.postMessage` listener that runs incoming
 * commands. Host pages drive the avatar via:
 *   `window.postMessage({ source: 'ania', cmd: 'action 1' }, targetOrigin)`
 *
 * @returns an uninstall function.
 */
export const installPostMessageControl = (
  ctx: CommandContext,
  options: {
    origins?: string[];
    onResult?: (result: CommandResult, event: MessageEvent) => void;
  } = {}
): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const origins = options.origins || [];
  const allowAll = origins.includes('*');
  const logger = ctx.logger || console;

  const handler = (event: MessageEvent): void => {
    const data = event && (event.data as { source?: string; cmd?: string });
    if (!data || data.source !== 'ania' || typeof data.cmd !== 'string') return;
    if (!allowAll && origins.length > 0 && !origins.includes(event.origin)) {
      logger.warn(`[commands] postMessage from disallowed origin "${event.origin}" ignored.`);
      return;
    }
    if (!allowAll && origins.length === 0) {
      logger.warn('[commands] postMessage control received but no origins allowlisted; ignoring.');
      return;
    }
    const result = executeCommand(data.cmd, ctx);
    options.onResult?.(result, event);
    const src = event.source as { postMessage?: (msg: unknown, origin: string) => void } | null;
    if (src && typeof src.postMessage === 'function') {
      try {
        src.postMessage(
          { source: 'ania-reply', cmd: data.cmd, result },
          event.origin && event.origin !== 'null' ? event.origin : '*'
        );
      } catch {
        /* ignore */
      }
    }
  };

  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
};
