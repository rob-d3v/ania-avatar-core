// Avatar JSON-config API service. Fetches lip-sync and actions config from the
// Ania server and builds an openness map.
//
// Endpoint: GET /api/avatars/json-config/fetch?contentHash=<hash>&type=<type>
//   type = 'lips_sync' | 'actions'
//
// Ported from the Chrome extension's `lib/services/avatar-config-api.ts`.

import type { ActionConfig, LipSyncServerConfig } from '../types';

interface JsonConfigResponse {
  found?: boolean;
  jsonData?: unknown;
}

const fetchJsonConfig = async (
  serverUrl: string,
  contentHash: string,
  type: string
): Promise<unknown | null> => {
  try {
    const url = `${serverUrl.replace(/\/$/, '')}/api/avatars/json-config/fetch?contentHash=${encodeURIComponent(
      contentHash
    )}&type=${encodeURIComponent(type)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as JsonConfigResponse;
    if (!data.found || !data.jsonData) return null;
    return data.jsonData;
  } catch {
    return null;
  }
};

/** Fetch the lip-sync server config for an avatar by its content hash. */
export const fetchLipSyncConfig = async (
  serverUrl: string,
  contentHash: string
): Promise<LipSyncServerConfig | null> =>
  (await fetchJsonConfig(serverUrl, contentHash, 'lips_sync')) as LipSyncServerConfig | null;

/** Fetch the actions server config for an avatar by its content hash. */
export const fetchActionsConfig = async (
  serverUrl: string,
  contentHash: string
): Promise<ActionConfig[] | null> => {
  const data = await fetchJsonConfig(serverUrl, contentHash, 'actions');
  if (!data) return null;
  if (Array.isArray(data)) return data as ActionConfig[];
  const wrapped = data as { actions?: ActionConfig[] };
  return Array.isArray(wrapped.actions) ? wrapped.actions : null;
};

/**
 * Build a per-frame openness map (0..1) for the talk range from keyframes.
 * `keyframes` is a list of `[absoluteFrameIndex, openness]` pairs. The result
 * is indexed by `(frameIndex - talkLow)`.
 */
export const buildOpennessMap = (
  keyframes: [number, number][] | undefined,
  talkLow: number,
  talkHigh: number
): number[] => {
  const talkSpan = talkHigh - talkLow;
  if (talkSpan <= 0 || !keyframes || keyframes.length === 0) return [];

  const n = talkSpan + 1;
  const result = new Array<number>(n).fill(0.5);

  const sortedKf = [...keyframes].sort((a, b) => a[0] - b[0]);
  let kfRel: [number, number][] = sortedKf.map(([idx, val]) => [
    Math.max(0, Math.min(talkSpan, Math.floor(idx) - talkLow)),
    typeof val === 'number' ? val : parseFloat(String(val)),
  ]);

  if (kfRel[0][0] > 0) kfRel = [[0, kfRel[0][1]], ...kfRel];
  if (kfRel[kfRel.length - 1][0] < talkSpan) {
    kfRel = [...kfRel, [talkSpan, kfRel[kfRel.length - 1][1]]];
  }

  for (let i = 0; i < kfRel.length - 1; i++) {
    const [i0, v0] = kfRel[i];
    const [i1, v1] = kfRel[i + 1];
    const span = Math.max(1, i1 - i0);
    for (let j = i0; j <= i1; j++) {
      const t = (j - i0) / span;
      result[j] = v0 + (v1 - v0) * t;
    }
  }

  return result;
};
