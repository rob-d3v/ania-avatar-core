// Tiny, dependency-free i18n resolver.
//
// Resolves a string key for a locale, falls back to English, does `{{var}}`
// interpolation, and lets a consumer override individual strings. No global
// state, no side effects, no heavy runtime (no i18next).
//
// The ~192 locale tables live as plain JSON under ./strings/<code>.json and are
// bundled eagerly through the generated ./strings-index module (which the build
// regenerates from the JSON files). Ported from the web-player's
// `i18n/index.js`, with the Vite `import.meta.glob` replaced by a static map.

import type { I18nVars, MessagesOverride, Translator } from '../types';
import { RAW_STRINGS, type RawTable } from './strings-index';

const DEFAULT_LOCALE = 'pt-BR';
const FALLBACK_LOCALE = 'en';

// Is this an index-keyed object that stands in for a list? (e.g.
// { "0": "...", "1": "..." } — how greetings/waiting are stored so the keyless
// translate script, which can't handle JSON arrays, can fill them.)
function isIndexObject(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
}

// Normalise a loaded table to FLAT dotted keys. Hand-authored base files store
// keys flat; the translate script re-nests them into a tree. Flattening makes
// both shapes resolve identically. List values are kept as leaves.
function flatten(obj: Record<string, unknown>, prefix: string, out: Record<string, unknown>): Record<string, unknown> {
  for (const k in obj) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !isIndexObject(v)) {
      flatten(v as Record<string, unknown>, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

// Build the flattened registry once from the generated raw tables.
const STRINGS: Record<string, Record<string, unknown>> = (() => {
  const out: Record<string, Record<string, unknown>> = {};
  for (const code in RAW_STRINGS) {
    const raw = (RAW_STRINGS[code] || {}) as RawTable;
    out[code] = flatten(raw as Record<string, unknown>, '', {});
  }
  return out;
})();

/** All locale codes that ship with the library (e.g. ['en','pt-BR','es',...]). */
export function availableLocales(): string[] {
  return Object.keys(STRINGS).sort();
}

/** True if a locale table is bundled for `locale`. */
export function hasLocale(locale: string): boolean {
  return !!(locale && STRINGS[locale]);
}

// Resolve a locale code to the best available table:
//   exact ('pt-BR') -> base language ('pt') -> any region of that base -> 'en'.
function resolveTable(locale?: string): Record<string, unknown> {
  if (locale && STRINGS[locale]) return STRINGS[locale];
  if (locale) {
    const base = String(locale).split('-')[0];
    if (STRINGS[base]) return STRINGS[base];
    const regional = Object.keys(STRINGS).find((c) => c.split('-')[0] === base);
    if (regional) return STRINGS[regional];
  }
  return STRINGS[FALLBACK_LOCALE] || {};
}

// Reconstruct an ordered array from a list-valued key (array or index-object).
function asList(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (value && typeof value === 'object') {
    return Object.keys(value as object)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => (value as Record<string, string>)[k]);
  }
  return null;
}

function interpolate(value: unknown, vars?: I18nVars): string {
  if (!vars || typeof value !== 'string') return value as string;
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

/** Resolve a single string by key for a locale. Returns the key if unmatched. */
export function getString(
  key: string,
  locale: string = DEFAULT_LOCALE,
  opts: { vars?: I18nVars; override?: MessagesOverride } = {}
): string {
  const { vars, override } = opts;
  if (override && override[key] != null && typeof override[key] === 'string') {
    return interpolate(override[key], vars);
  }
  const table = resolveTable(locale);
  let value = table[key];
  if (value == null) {
    const fb = STRINGS[FALLBACK_LOCALE] || {};
    value = fb[key];
  }
  if (value == null) return key;
  return interpolate(value, vars);
}

/** Resolve a list-valued key (e.g. 'greetings', 'waiting'). */
export function getStringList(
  key: string,
  locale: string = DEFAULT_LOCALE,
  opts: { override?: MessagesOverride } = {}
): string[] {
  const { override } = opts;
  if (override && Array.isArray(override[key])) return override[key] as string[];
  const table = resolveTable(locale);
  let list = asList(table[key]);
  if (list == null) {
    const fb = STRINGS[FALLBACK_LOCALE] || {};
    list = asList(fb[key]);
  }
  return list || [];
}

/** Build a translator bound to one locale + optional override table. */
export function createTranslator(
  locale: string = DEFAULT_LOCALE,
  override?: MessagesOverride
): Translator {
  return {
    locale,
    t: (key: string, vars?: I18nVars) => getString(key, locale, { vars, override }),
    list: (key: string) => getStringList(key, locale, { override }),
  };
}

export { DEFAULT_LOCALE, FALLBACK_LOCALE };
