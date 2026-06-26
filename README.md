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
