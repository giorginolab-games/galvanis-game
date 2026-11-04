/**
 * Procedural sound: every effect and the background loop are synthesised with Web Audio, so there are no assets.
 * The context is created lazily on the first user gesture (browsers block audio before one).
 */

type Bus = "sfx" | "music";

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  slideTo?: number;
  delay?: number;
  at?: number;
  lowpass?: number;
  bus?: Bus;
}

interface NoiseOptions {
  filter?: BiquadFilterType;
  freq?: number;
  freqTo?: number;
  q?: number;
  gain?: number;
  delay?: number;
  at?: number;
  crackle?: boolean;
  bus?: Bus;
}

// Am – F – C – G, as MIDI chord tones.
const PROGRESSION = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];

const midiToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sequencer: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private tempo = 100;
  private wantMusic = false;

  constructor(
    private sfxEnabled: boolean,
    private musicEnabled: boolean,
  ) {}

  get sfxOn(): boolean {
    return this.sfxEnabled;
  }

  get musicOn(): boolean {
    return this.musicEnabled;
  }

  /** Call from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!Ctor) {
        return;
      }

      const ctx = new Ctor();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.ratio.value = 4;
      compressor.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(compressor);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 0.9;
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.2;
      this.musicBus.connect(this.master);

      const length = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);

      for (let i = 0; i < length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }

      this.ctx = ctx;
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    if (this.wantMusic) {
      this.startSequencer();
    }
  }

  setSfx(on: boolean): void {
    this.sfxEnabled = on;
  }

  setMusic(on: boolean): void {
    this.musicEnabled = on;

    if (on && this.wantMusic) {
      this.startSequencer();
    } else {
      this.stopSequencer();
    }
  }

  /** Background loop; tempo rises with the level. */
  playMusic(level: number): void {
    this.wantMusic = true;
    this.tempo = Math.min(150, 96 + 4 * (level - 1));
    this.startSequencer();
  }

  stopMusic(): void {
    this.wantMusic = false;
    this.stopSequencer();
  }

  setTempoForLevel(level: number): void {
    this.tempo = Math.min(150, 96 + 4 * (level - 1));
  }

  // ---- Effects ---------------------------------------------------------------------------------------------------

  click(): void {
    this.tone(660, 0.05, { type: "triangle", gain: 0.06 });
  }

  move(): void {
    this.tone(300, 0.035, { type: "square", gain: 0.025, lowpass: 1200 });
  }

  rotate(): void {
    this.tone(520, 0.07, { type: "triangle", gain: 0.06, slideTo: 820 });
  }

  drop(): void {
    this.noise(0.18, { filter: "bandpass", freq: 2200, freqTo: 300, q: 1.2, gain: 0.14 });
    this.tone(200, 0.16, { type: "sine", gain: 0.12, slideTo: 70 });
  }

  land(): void {
    this.tone(120, 0.18, { type: "sine", gain: 0.35, slideTo: 45 });
    this.noise(0.05, { filter: "lowpass", freq: 900, gain: 0.12 });
  }

  /** The discharge: crackling band-limited noise over a mains-like buzz. */
  zap(chain: number, high: boolean): void {
    const duration = high ? 1.05 : 0.75;
    const lift = 1 + 0.12 * Math.max(0, chain - 1);

    this.noise(duration, { filter: "bandpass", freq: 2600 * lift, q: 0.7, gain: high ? 0.5 : 0.36, crackle: true });
    this.tone(55 * lift, duration * 0.9, { type: "sawtooth", gain: 0.1, lowpass: 1400 });
    this.tone(110 * lift, duration * 0.8, { type: "square", gain: 0.035, lowpass: 900 });
    this.tone(2400 * lift, 0.35, { type: "sine", gain: 0.05, slideTo: 300 });

    if (high) {
      this.tone(70, 0.8, { type: "sine", gain: 0.5, slideTo: 28 });
    }

    if (chain > 1) {
      const base = 72 + 2 * Math.min(chain, 8);
      [0, 4, 7].forEach((offset, index) => this.tone(midiToHz(base + offset), 0.18, { type: "triangle", gain: 0.08, delay: 0.05 * index }));
    }
  }

  burn(): void {
    this.noise(0.25, { filter: "highpass", freq: 3000, gain: 0.08 });
    this.tone(900, 0.2, { type: "triangle", gain: 0.05, slideTo: 1800 });
  }

  pulseCharge(): void {
    this.tone(150, 0.28, { type: "sawtooth", gain: 0.09, slideTo: 1500, lowpass: 3200 });
  }

  chargeGained(): void {
    this.tone(880, 0.25, { type: "triangle", gain: 0.1 });
    this.tone(1320, 0.35, { type: "triangle", gain: 0.09, delay: 0.08 });
  }

  denied(): void {
    this.tone(150, 0.12, { type: "square", gain: 0.06, lowpass: 700 });
    this.tone(115, 0.16, { type: "square", gain: 0.06, lowpass: 700, delay: 0.1 });
  }

  levelUp(): void {
    [72, 76, 79, 84, 88].forEach((note, index) => this.tone(midiToHz(note), 0.22, { type: "triangle", gain: 0.1, delay: index * 0.07 }));
  }

  gameOver(): void {
    this.tone(440, 1.3, { type: "sawtooth", gain: 0.14, slideTo: 50, lowpass: 1600 });
    [64, 60, 57, 52].forEach((note, index) => this.tone(midiToHz(note), 0.4, { type: "triangle", gain: 0.1, delay: 0.25 + index * 0.22 }));
  }

  // ---- Synthesis primitives --------------------------------------------------------------------------------------

  private bus(bus: Bus): { ctx: AudioContext; node: GainNode } | null {
    if (!this.ctx || this.ctx.state !== "running") {
      return null;
    }

    if (bus === "sfx" ? !this.sfxEnabled : !this.musicEnabled) {
      return null;
    }

    const node = bus === "sfx" ? this.sfxBus : this.musicBus;
    return node ? { ctx: this.ctx, node } : null;
  }

  private tone(freq: number, duration: number, options: ToneOptions = {}): void {
    const target = this.bus(options.bus ?? "sfx");

    if (!target) {
      return;
    }

    const { ctx, node } = target;
    const t = (options.at ?? ctx.currentTime) + (options.delay ?? 0);
    const oscillator = ctx.createOscillator();
    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(freq, t);

    if (options.slideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(options.slideTo, t + duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(options.gain ?? 0.2, t + (options.attack ?? 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    let source: AudioNode = oscillator;

    if (options.lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = options.lowpass;
      oscillator.connect(filter);
      source = filter;
    }

    source.connect(gain);
    gain.connect(node);
    oscillator.start(t);
    oscillator.stop(t + duration + 0.05);
  }

  private noise(duration: number, options: NoiseOptions = {}): void {
    const target = this.bus(options.bus ?? "sfx");

    if (!target || !this.noiseBuffer) {
      return;
    }

    const { ctx, node } = target;
    const t = (options.at ?? ctx.currentTime) + (options.delay ?? 0);
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = options.filter ?? "lowpass";
    filter.frequency.setValueAtTime(options.freq ?? 1000, t);
    filter.Q.value = options.q ?? 1;

    if (options.freqTo) {
      filter.frequency.exponentialRampToValueAtTime(options.freqTo, t + duration);
    }

    const gain = ctx.createGain();
    const peak = options.gain ?? 0.2;

    if (options.crackle) {
      // Random gating every ~12 ms makes the noise crackle like an arc rather than hiss.
      const slices = Math.max(1, Math.floor(duration / 0.012));

      for (let i = 0; i < slices; i += 1) {
        const decay = 1 - i / slices;
        gain.gain.setValueAtTime(peak * decay * (0.15 + 0.85 * Math.random() ** 2), t + i * 0.012);
      }

      gain.gain.linearRampToValueAtTime(0, t + duration);
    } else {
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    }

    source.connect(filter);
    filter.connect(gain);
    gain.connect(node);
    source.start(t, Math.random() * 1.5);
    source.stop(t + duration + 0.05);
  }

  // ---- Music sequencer -------------------------------------------------------------------------------------------

  private startSequencer(): void {
    if (this.sequencer !== null || !this.ctx || !this.musicEnabled) {
      return;
    }

    this.nextStepTime = this.ctx.currentTime + 0.05;
    this.sequencer = window.setInterval(() => this.scheduleSteps(), 25);
  }

  private stopSequencer(): void {
    if (this.sequencer !== null) {
      window.clearInterval(this.sequencer);
      this.sequencer = null;
    }
  }

  private scheduleSteps(): void {
    if (!this.ctx) {
      return;
    }

    // Catch up after a stall instead of firing a burst of overdue notes.
    if (this.nextStepTime < this.ctx.currentTime - 0.2) {
      this.nextStepTime = this.ctx.currentTime + 0.02;
    }

    while (this.nextStepTime < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextStepTime);
      this.nextStepTime += 60 / this.tempo / 4;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, at: number): void {
    const chord = PROGRESSION[Math.floor(step / 16) % PROGRESSION.length];
    const beat = step % 16;
    const music = { bus: "music" as const, at };

    if (beat % 8 === 0) {
      this.tone(95, 0.14, { ...music, type: "sine", gain: 0.5, slideTo: 40 });
    }

    if (beat % 4 === 2) {
      this.noise(0.03, { ...music, filter: "highpass", freq: 7000, gain: 0.12 });
    }

    if (beat % 2 === 0) {
      const octave = beat === 6 || beat === 14 ? 12 : 0;
      this.tone(midiToHz(chord[0] - 24 + octave), 0.2, { ...music, type: "sawtooth", gain: 0.22, lowpass: 420 });
    }

    if (beat % 2 === 1) {
      const note = chord[(beat >> 1) % 3] + (beat >= 8 ? 12 : 0);
      this.tone(midiToHz(note), 0.14, { ...music, type: "triangle", gain: 0.1 });
    }
  }

  destroy(): void {
    this.stopSequencer();
    void this.ctx?.close();
    this.ctx = null;
  }
}
