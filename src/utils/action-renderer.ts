// Action audio playback — decode a base64 audio clip and play it, with an
// optional delay and a cancel handle. Framework-free; ported from the Chrome
// extension's `lib/utils/action-renderer.ts`.

export interface ActionAudioHandle {
  cancel: () => void;
}

/**
 * Play action audio from a base64 string (with or without a `data:` prefix).
 * When `delayMs > 0`, playback is deferred and the returned handle cancels the
 * pending timer too. Returns null when there is nothing to play (or no DOM Audio).
 */
export const playActionAudio = (
  audioBase64?: string | null,
  delayMs = 0
): ActionAudioHandle | null => {
  if (!audioBase64) return null;
  if (typeof Audio === 'undefined') return null;

  const play = (): HTMLAudioElement | null => {
    try {
      const dataUrl = audioBase64.startsWith('data:')
        ? audioBase64
        : `data:audio/wav;base64,${audioBase64}`;
      const audio = new Audio(dataUrl);
      void audio.play().catch(() => {
        /* autoplay may be blocked; swallow */
      });
      return audio;
    } catch {
      return null;
    }
  };

  if (delayMs > 0) {
    let audioRef: HTMLAudioElement | null = null;
    const timer = setTimeout(() => {
      audioRef = play();
    }, delayMs);
    return {
      cancel: () => {
        clearTimeout(timer);
        if (audioRef) {
          audioRef.pause();
          audioRef = null;
        }
      },
    };
  }

  const audio = play();
  return audio ? { cancel: () => audio.pause() } : null;
};
