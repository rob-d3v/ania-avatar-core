# ania-avatar-core

Framework-agnostic TypeScript engine for the **Ania animated-avatar player**.

`ania-avatar-core` mounts an avatar player onto a `<canvas>`/container and drives
lip-sync, actions, commands, plugins, and TTS/STT/wake-word — all with a clean
imperative API and zero framework dependencies. It is the shared engine that
powers the Vue / Angular / Svelte / Web-Component wrappers: each wrapper simply
instantiates the engine and binds its reactive props/events to these methods.

- **Dependency-light** — only optional peer deps (`onnxruntime-web`,
  `piper-tts-web`) for on-device wake-word / TTS, lazily imported and degrading
  gracefully when absent.
- **Tree-shakeable** — `sideEffects: false`, dual ESM/CJS + a UMD/IIFE global.
- **Fully typed** — a real bundled `.d.ts`. Every type is exported.
- **192 bundled locales** for built-in strings, via a tiny dependency-free
  resolver (no i18next).

## Install

```bash
npm install ania-avatar-core
# optional (on-device wake-word + neural TTS):
npm install onnxruntime-web piper-tts-web
```

## Quick start (npm / bundler)

```ts
import { createAniaPlayer, LipSyncAnalyser } from 'ania-avatar-core';

const canvas = document.querySelector('canvas')!;
const player = createAniaPlayer(canvas, { width: 320, height: 320, autoplay: true });

player.on('load', (data) => console.log('frames:', data.video.frames.length));
player.on('talkStart', () => console.log('talking'));
player.on('actionStart', (id) => console.log('action', id));

// Load a market (unencrypted) or personal (password) .ania file by URL:
await player.load({ url: '/avatars/ania.ania', password: 'secret', authToken: 'JWT' });

// Or load already-decrypted data directly:
// await player.load(avatarData);

// Drive lip-sync from the microphone:
const analyser = new LipSyncAnalyser({ inputGain: 1.2 });
await analyser.connectMicrophone();
player.setOpennessSource(() => analyser.getOpenness());
player.configureLipsSync(true, 0.6, 0.5);
player.setTalking(true);

// Trigger an action:
player.triggerAction('wave');
```

## Quick start (CDN `<script>`)

The UMD/IIFE build exposes the global **`AniaAvatarCore`**:

```html
<canvas id="ania" width="320" height="320"></canvas>
<script src="https://cdn.jsdelivr.net/npm/ania-avatar-core/dist/index.global.js"></script>
<script>
  const player = AniaAvatarCore.createAniaPlayer(document.getElementById('ania'), {
    autoplay: true,
  });
  player.load({ url: 'https://example.com/avatar.ania' });
</script>
```

(`unpkg.com/ania-avatar-core` resolves the same file via the `unpkg` field.)

## What's in the box

| Area            | Exports |
| --------------- | ------- |
| Player          | `createAniaPlayer`, `AniaPlayer`, `AnimationController`, `Emitter`, `buildControllerConfig` |
| Crypto          | `decryptAniaFile` (v1/v2/v3, market + personal) |
| Audio           | `LipSyncAnalyser`, `SpeechRecognizer` |
| Commands        | `executeCommand`, `parseCommandLine`, `installPostMessageControl`, `COMMAND_LIST` |
| Plugins         | `PluginRegistry`, `getDefaultRegistry`, `validatePlugin`, `BUILTIN_PLUGINS`, `registerBuiltins`, the per-provider built-ins |
| Services        | `fetchActionsConfig`, `fetchLipSyncConfig`, `buildOpennessMap`, `professionalTTSRequest`, `WakeWordEngine`, Piper TTS helpers |
| Utils           | `parseHotkey`, `matchesHotkey`, `playActionAudio`, `calcSpeeds`, `AvatarCache` |
| i18n            | `getString`, `getStringList`, `createTranslator`, `availableLocales`, `hasLocale` |
| Mocap (Ania 2.0) | `computeDescriptor`, `OneEuroVector`, `MotionMatcher`, `MatcherError`, `buildMotionGraph`, `buildPosesIndex`, `buildCoverage`, `sequencesFromRanges` |

See **[API.md](./API.md)** for the precise, final type signatures — wrapper
libraries build against that contract.

## Commands

`executeCommand(line, ctx)` parses a desktop-style command line and drives the
avatar through a `CommandContext` you wire up:

```ts
import { executeCommand } from 'ania-avatar-core';

const ctx = {
  player,
  getActions: () => player.getAvailableActions(),
  triggerAction: (id) => player.triggerAction(id),
  setVisible: (v) => (v ? player.play() : player.pause()),
  speak: (text) => myTts.speak(text),
};

executeCommand('action 1', ctx);     // trigger first action
executeCommand('speed 2 4', ctx);    // idle=2, talk=4
executeCommand('tts "hello there"', ctx);
executeCommand('help');              // -> { ok, message } with the full list
```

Verbs: `show hide toggle action actions info speed sensitivity mute unmute tts
ask (alias provider) wake stop help`.

## Plugins

Each TTS/STT/wake-word provider is a registrable `Plugin`; one provider per kind
is "active":

```ts
import { PluginRegistry, registerBuiltins } from 'ania-avatar-core';

const registry = new PluginRegistry();
registerBuiltins(registry);
registry.setActive('tts', 'tts-piper');

const tts = await registry.resolveEngine('tts', {
  config: { piperModelUrl: '/models/voice.onnx', piperModelConfigUrl: '/models/voice.onnx.json' },
});
await tts?.speak?.('Olá!');
```

Register your own:

```ts
registry.register({
  id: 'my-tts', name: 'My TTS', kind: 'tts',
  createEngine: () => ({ async speak(text) { /* ... */ } }),
});
```

## Mocap (Ania 2.0)

A TypeScript port of the desktop player's motion-matching core
(`AniaAPP/src/ania_player/plugins/mocap_webcam/`): a webcam/mocap pose stream
drives frame selection against a pre-indexed avatar "pose bank", instead of the
usual idle/talk cycling. It is additive — an avatar with no pose bank behaves
exactly as before.

```ts
import { createAniaPlayer } from 'ania-avatar-core';

const player = createAniaPlayer(canvas);
await player.load({ url: '/avatars/ania.ania' });

// poses.json (+ optional motion_graph.json), fetched however the host prefers:
const poses = await fetch('/avatars/ania.poses.json').then((r) => r.json());
const motionGraph = await fetch('/avatars/ania.motion_graph.json').then((r) => r.json());

if (player.configureMocap({ poses, motionGraph })) {
  player.setMocapEnabled(true);
}

// Feed one live pose sample per capture tick (from a MediaPipe Face/Pose/Hand
// pipeline via `computeDescriptor`, or any estimator emitting the same wire shape):
player.pushPose({ v: 1, t: performance.now(), mask: 127, norm: 'raw', d: values });

player.isMocapActive();   // did the mocap branch drive the last rendered frame?
player.getMocapMode();    // 'LIVE' | 'DECAY' | 'IDLE' | null
player.getMocapDebug();   // { E_best, S_best, age_ms, candidates, ema_E, run_ticks, dwell }
player.getMocapResidual(); // live target minus the chosen frame's descriptor
```

**Data contract** — PoseDescriptor v1: 48 float values (40 used, 8 reserved) plus
an 8-bit group mask (`{HEAD, MOUTH, EYES, BROWS, BODY, HAND_L, HAND_R, reserved}`).
`computeDescriptor(face, blend, pose, hands, mirror)` builds one from MediaPipe-shaped
landmarks — either flat row-major `Float64Array|number[]` (stride 3 for face/hands,
4 for pose) or arrays of `{x, y, z?, visibility?}` points — never from a 4x4 head
matrix, so the capture side, the offline pose indexer, and this port all land in
the same space. `descriptorVersion` gates everything; `configureMocap` returns
`false` (and logs) on a mismatch instead of throwing, so a host keeps playing
normally with mocap simply off.

### Building the index in the browser

`buildMotionGraph`, `buildPosesIndex` and `buildCoverage` are the client-side
port of the desktop indexer (`mocap_webcam/graph.py` and `index.py`), so a host
can produce `motion_graph.json`, `poses.json` and `coverage.json` from the avatar's
own frames instead of asking the user to load a pre-built index file. They are
pure functions over plain arrays — no DOM, no canvas, no `document` — so the
caller decodes the frames once and runs the whole thing inside a Web Worker:
`buildMotionGraph(frames, { frameSeq, k, edgeCostMax, costClip, cutThreshold, window, restFrame, onProgress })`
takes `ImageData`-shaped RGBA buffers, computes the per-frame visual signature
(32² luma-over-grey + 32² alpha + 16² Sobel, weighted 0.5/0.3/0.2), the all-pairs
squared distance and the CSR graph (successor, predecessor, symmetrised k-NN, hub
edges to the rest frame) with `motionEnergy`, `restFrame`, `cuts` and
`succCostMedian`; `buildPosesIndex(descriptors, masks, seq, opts)` assembles
`poses.json` (p05/p95 ranges, neutral, rest frame, `dimValid`, `frameSeq`), with
`sequencesFromRanges`/`frameSeq` for the idle/talk/action/orphan split; and
`buildCoverage(poses)` produces the marginal bins, the 7×5 yaw/pitch histogram,
the hand-visibility quadrants, the `count < 3` gap list with its calibration
preset, and `coverageScore`. Parity is bit-exact, not approximate: the signature
runs entirely in float32 (`Math.fround` at every step, like numpy), `boxResizeRgba`
reproduces Pillow's BOX resampler byte for byte — alpha-premultiplied, horizontal
pass then vertical, 22-bit fixed-point coefficients (a naive per-channel box
average is off by up to 85/255 on frames with varying alpha), and `pyRound`
reproduces Python's round-half-to-even `round(x, n)` on every emitted number.
The fixtures `graph_cases.json` (3 synthetic banks at 32×32, 48×48 and 40×24,
84 frames, 825 edges, plus 5 standalone resize cases) and `coverage_cases.json`
(3 banks, 160 frames) are generated by `AniaAPP/tools/mocap_lab/export_fixtures.py`
and checked by `examples/test-mocap-graph.mjs` / `examples/test-mocap-coverage.mjs`:
every integer array matches exactly and every float to the fixture's own 1e-6
serialisation floor.

See `wiki/concepts/ania-2-0-pose-descriptor-and-motion-graph.md` in the
AnimatedAvatar repo for the full spec (cost space, LIVE/DECAY/IDLE modes, the
teleport gate, One-Euro tuning per group). The parity fixtures under
`AniaAPP/tests/fixtures/mocap/` pin this port's behaviour against the Python
reference bit-for-bit (frame/preload/mode selection is exact; the descriptor and
One-Euro maths match to float32/float64 rounding).

## Optional dependencies

`onnxruntime-web` and `piper-tts-web` are **optional peer dependencies**. They
are imported lazily, only on first use of the wake-word engine or Piper TTS.
Without them installed, the rest of the engine works unchanged; the wake-word /
Piper paths reject with a clear, swallow-able error (and
`isWakeWordSupported()` returns `false`).

## Browser support

Targets ES2020. Requires the Web Crypto API (`crypto.subtle`) for decryption,
Web Audio for lip-sync, and `requestAnimationFrame` for rendering — all standard
in modern browsers (and Node 16+ for the crypto/parsing pieces).

## License

MIT
