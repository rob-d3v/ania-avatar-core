// LipSyncAnalyser — turns an audio source (mic MediaStream, an <audio>/<video>
// element, or a raw MediaStream) into a live "mouth openness" value 0..1 that
// the AnimationController consumes each frame.
//
// Two openness measures are available:
//   - getOpenness()       — averaged magnitude over the 85–3000 Hz speech band
//                           (good general-purpose lip-sync), gain-scaled.
//   - getAmplitude()      — peak time-domain amplitude (snappier, noisier).
//   - getSpectralFlux()   — positive spectral change (useful for plosive accents).
//
// Merges the web-player `useLipSync` spectral analysis with the Chrome
// extension content-script's mic-amplitude path. Framework-free.

export interface LipSyncAnalyserOptions {
  /** FFT size (power of two). Default 2048. */
  fftSize?: number;
  /** Analyser smoothing 0..1. Default 0.8. */
  smoothing?: number;
  /** Linear gain applied to the openness reading. Default 1. */
  inputGain?: number;
}

type Ctor = typeof AudioContext;

export class LipSyncAnalyser {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioNode | null = null;
  private freqData: Uint8Array | null = null;
  private prevSpectrum: Float32Array | null = null;
  private ownsStream = false;
  private stream: MediaStream | null = null;
  private connectedElement: HTMLMediaElement | null = null;

  private fftSize: number;
  private smoothing: number;
  public inputGain: number;

  constructor(options: LipSyncAnalyserOptions = {}) {
    this.fftSize = options.fftSize ?? 2048;
    this.smoothing = options.smoothing ?? 0.8;
    this.inputGain = options.inputGain ?? 1;
  }

  private getOrCreateContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const C =
        (window as { AudioContext?: Ctor; webkitAudioContext?: Ctor }).AudioContext ||
        (window as { webkitAudioContext?: Ctor }).webkitAudioContext!;
      this.ctx = new C();
    }
    return this.ctx;
  }

  private buildAnalyser(): AnalyserNode {
    const ctx = this.getOrCreateContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.fftSize;
    analyser.smoothingTimeConstant = this.smoothing;
    this.analyser = analyser;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    this.prevSpectrum = new Float32Array(analyser.frequencyBinCount);
    return analyser;
  }

  /**
   * Connect a microphone. Requests `getUserMedia({ audio })` unless a stream is
   * supplied. The mic is NOT routed to the speakers (analysis only).
   */
  async connectMicrophone(stream?: MediaStream, deviceId?: string): Promise<void> {
    this.disconnect();
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      });
      this.ownsStream = true;
    }
    this.stream = stream;
    const ctx = this.getOrCreateContext();
    const analyser = this.buildAnalyser();
    const src = ctx.createMediaStreamSource(stream);
    this.source = src;
    src.connect(analyser);
    // Note: no analyser.connect(destination) — we don't want mic feedback.
  }

  /** Connect a raw MediaStream (e.g. system / tab audio). */
  async connectStream(stream: MediaStream): Promise<void> {
    return this.connectMicrophone(stream);
  }

  /**
   * Connect an `<audio>`/`<video>` element (e.g. a TTS playback element). The
   * element's audio is routed through to the speakers so it still plays.
   */
  connectAudioElement(el: HTMLMediaElement): void {
    if (this.connectedElement === el && this.analyser) return;
    this.disconnect();
    const ctx = this.getOrCreateContext();
    const analyser = this.buildAnalyser();
    try {
      const src = ctx.createMediaElementSource(el);
      this.source = src;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      this.connectedElement = el;
    } catch {
      /* element may already have a source node; leave analyser detached */
    }
  }

  /**
   * Average magnitude over the speech band (85–3000 Hz), normalized 0..1 and
   * scaled by `inputGain`. This is the value to feed the controller.
   */
  getOpenness(): number {
    if (!this.analyser || !this.freqData || !this.ctx) return 0;
    this.analyser.getByteFrequencyData(this.freqData as unknown as Uint8Array<ArrayBuffer>);

    const binSize = this.ctx.sampleRate / this.analyser.fftSize;
    const lowBin = Math.floor(85 / binSize);
    const highBin = Math.min(this.freqData.length - 1, Math.ceil(3000 / binSize));

    let sum = 0;
    let count = 0;
    for (let i = lowBin; i <= highBin; i++) {
      sum += this.freqData[i];
      count++;
    }
    if (count === 0) return 0;
    return Math.min(1, ((sum / count) / 255) * this.inputGain);
  }

  /** Peak time-domain amplitude 0..1. */
  getAmplitude(): number {
    if (!this.analyser) return 0;
    const timeData = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(timeData as unknown as Uint8Array<ArrayBuffer>);
    let maxAmp = 0;
    for (let i = 0; i < timeData.length; i++) {
      const amp = Math.abs(timeData[i] - 128) / 128;
      if (amp > maxAmp) maxAmp = amp;
    }
    return Math.min(1, maxAmp * this.inputGain);
  }

  /** Positive spectral flux 0..1 (rising energy). */
  getSpectralFlux(): number {
    if (!this.analyser || !this.freqData || !this.prevSpectrum) return 0;
    this.analyser.getByteFrequencyData(this.freqData as unknown as Uint8Array<ArrayBuffer>);
    let flux = 0;
    const len = Math.min(this.freqData.length, this.prevSpectrum.length);
    for (let i = 0; i < len; i++) {
      const diff = this.freqData[i] / 255 - this.prevSpectrum[i];
      if (diff > 0) flux += diff;
      this.prevSpectrum[i] = this.freqData[i] / 255;
    }
    return Math.min(1, flux / (len * 0.1));
  }

  isConnected(): boolean {
    return !!this.analyser;
  }

  /** Detach nodes and stop any stream this analyser created. */
  disconnect(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        /* ignore */
      }
      this.analyser = null;
    }
    if (this.ownsStream && this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.ownsStream = false;
    this.connectedElement = null;
    this.freqData = null;
    this.prevSpectrum = null;
  }

  /** Fully dispose (disconnect + close the AudioContext). */
  async destroy(): Promise<void> {
    this.disconnect();
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
  }
}
