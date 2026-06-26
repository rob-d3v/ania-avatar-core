// Parse hotkey strings (e.g. "ctrl+shift+1") and match them against keyboard
// events. Framework-free; ported from the Chrome extension's
// `lib/utils/hotkey-parser.ts`.

export interface ParsedHotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** Parse a hotkey string into modifier flags + base key. Returns null if no key. */
export const parseHotkey = (hotkeyString?: string | null): ParsedHotkey | null => {
  if (!hotkeyString) return null;

  const parts = hotkeyString.toLowerCase().split('+').map((p) => p.trim());
  const result: ParsedHotkey = { ctrl: false, alt: false, shift: false, meta: false, key: '' };

  for (const part of parts) {
    switch (part) {
      case 'ctrl':
      case 'control':
        result.ctrl = true;
        break;
      case 'alt':
        result.alt = true;
        break;
      case 'shift':
        result.shift = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
      case 'win':
        result.meta = true;
        break;
      default:
        result.key = part;
    }
  }

  return result.key ? result : null;
};

/** True if a keyboard event matches a parsed hotkey (modifiers + key). */
export const matchesHotkey = (event: KeyboardEvent, parsed: ParsedHotkey | null): boolean => {
  if (!parsed) return false;
  if (event.ctrlKey !== parsed.ctrl) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.metaKey !== parsed.meta) return false;
  return event.key.toLowerCase() === parsed.key;
};
