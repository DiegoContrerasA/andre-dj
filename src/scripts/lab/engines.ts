// Motores de reproducción para comparar en /lab. Misma interfaz para todos.
import * as Tone from 'tone';
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

export type EngineId = 'audio' | 'stretch' | 'player' | 'player-ps' | 'grain';

export interface Engine {
  readonly id: EngineId;
  readonly duration: number;
  readonly playing: boolean;
  play(): void;
  pause(): void;
  seek(t: number): void;
  setRate(r: number): void;
  setPitchLock(on: boolean): void;
  position(): number;
  dispose(): void;
  /** Ajustes propios (tamaño de grano, ventana del pitch shift) */
  tune?(k: string, v: number): void;
  /** Métricas del motor para el panel */
  stats(): Record<string, string>;
}

export const FADE = 0.015; // 15 ms: suficiente para que un corte no haga clic, demasiado corto para notarse

/** Reloj propio: posición = offset + (t − t0) · rate. Tone no expone la posición de un Player/GrainPlayer. */
export class Track {
  off = 0; t0 = 0; rate = 1; on = false;
  pos(now: number) { return this.on ? this.off + Math.max(0, now - this.t0) * this.rate : this.off; }
  start(at: number, off: number) { this.off = off; this.t0 = at; this.on = true; }
  stop(now: number) { this.off = this.pos(now); this.on = false; }
  setRate(at: number, r: number) { if (this.on) { this.off = this.pos(at); this.t0 = at; } this.rate = r; }
}

const ct = () => Tone.getContext().currentTime;
const cents = (r: number) => 1200 * Math.log2(r);

// ---------- 1. HTMLAudioElement (el motor actual de la app) ----------
export class AudioEngine implements Engine {
  readonly id = 'audio' as const;
  private a = new Audio();
  private url: string;
  private seekT0 = 0;
  private seekMs: number[] = [];
  private waits = 0;
  private target: number | null = null;
  private queued = false;

  constructor(blob: Blob) {
    this.url = URL.createObjectURL(blob);
    this.a.preload = 'auto';
    (this.a as any).playsInline = true;
    this.a.src = this.url;
    this.a.addEventListener('seeking', () => { if (!this.seekT0) this.seekT0 = performance.now(); });
    this.a.addEventListener('seeked', () => {
      if (this.queued && this.target != null) { this.queued = false; this.a.currentTime = this.target; return; }
      this.target = null;
      if (this.seekT0) { this.seekMs.push(performance.now() - this.seekT0); this.seekT0 = 0; }
    });
    this.a.addEventListener('waiting', () => this.waits++);
  }
  get duration() { return this.a.duration || 0; }
  get playing() { return !this.a.paused; }
  play() { this.a.play().catch((e) => this.onError?.(`No se pudo reproducir: ${e?.name || e}`)); }
  onError?: (msg: string) => void;
  pause() { this.a.pause(); }
  seek(t: number) {
    if (!this.duration) return;
    this.target = t;
    if (this.a.seeking) { this.queued = true; return; }
    this.a.currentTime = t;
  }
  setRate(r: number) {
    if (Math.abs(this.a.playbackRate - r) > 1e-4) this.a.playbackRate = r;
    this.a.defaultPlaybackRate = r;
  }
  setPitchLock(on: boolean) { this.a.preservesPitch = on; (this.a as any).webkitPreservesPitch = on; }
  position() { return this.target ?? this.a.currentTime; }
  stats() {
    const last = this.seekMs.slice(-5);
    return {
      'Seek (últimos, ms)': last.length ? last.map((m) => m.toFixed(0)).join(' · ') : '—',
      'Esperas (waiting)': String(this.waits),
      'RAM de audio': 'pocos MB (lee del archivo)',
    };
  }
  dispose() {
    this.a.pause();
    this.a.removeAttribute('src');
    this.a.load();
    URL.revokeObjectURL(this.url);
  }
}

// ---------- 2 y 3. Tone.Player (opcionalmente + PitchShift para conservar el tono) ----------
export class PlayerEngine implements Engine {
  readonly id: EngineId;
  private buf: Tone.ToneAudioBuffer;
  private p: Tone.Player;
  private ps: Tone.PitchShift | null = null;
  private t = new Track();
  private lock = true;
  private seeks = 0;

  constructor(audio: AudioBuffer, withPitchShift: boolean, windowSize = 0.1) {
    this.id = withPitchShift ? 'player-ps' : 'player';
    this.buf = new Tone.ToneAudioBuffer(audio);
    this.p = new Tone.Player(this.buf);
    // Player.seek() para la fuente vieja con fadeOut y arranca la nueva con fadeIn: fundido cruzado sin clic
    this.p.fadeIn = FADE;
    this.p.fadeOut = FADE;
    if (withPitchShift) {
      this.ps = new Tone.PitchShift({ windowSize });
      this.p.chain(this.ps, Tone.getDestination());
    } else this.p.toDestination();
  }
  get duration() { return this.buf.duration; }
  get playing() { return this.t.on; }
  // Las fuentes nativas se programan en el hilo de audio: se puede arrancar a 30 ms sin esperar el lookAhead
  private soon() { return ct() + 0.03; }
  play() {
    if (this.t.on) return;
    const at = this.soon(), off = Math.min(this.t.off, this.duration - 0.05);
    this.p.start(at, off);
    this.t.start(at, off);
  }
  pause() {
    if (!this.t.on) return;
    this.p.stop(ct() + 0.01);
    this.t.stop(ct());
  }
  seek(t: number) {
    this.seeks++;
    if (!this.t.on) { this.t.off = t; return; }
    const at = this.soon();
    this.p.seek(t, at);
    this.t.start(at, t);
  }
  setRate(r: number) {
    this.p.playbackRate = r; // Tone lo aplica en now() = currentTime + lookAhead
    this.t.setRate(Tone.now(), r);
    this.applyPitch();
  }
  setPitchLock(on: boolean) { this.lock = on; this.applyPitch(); }
  private applyPitch() {
    // El Player sube el tono con la velocidad; el PitchShift lo baja lo mismo
    if (this.ps) this.ps.pitch = this.lock ? -cents(this.t.rate) / 100 : 0;
  }
  tune(k: string, v: number) { if (k === 'windowSize' && this.ps) this.ps.windowSize = v; }
  position() {
    const p = this.t.pos(ct());
    if (this.t.on && p >= this.duration) { this.t.stop(ct()); this.t.off = this.duration; }
    return Math.min(p, this.duration);
  }
  stats() {
    return {
      Seeks: String(this.seeks),
      'Tono': this.ps ? (this.lock ? 'PitchShift compensa' : 'cambia con la velocidad') : 'cambia con la velocidad',
      'RAM de audio': mb(this.buf.get()!),
    };
  }
  dispose() {
    this.p.stop();
    this.p.dispose();
    this.ps?.dispose();
    this.buf.dispose();
  }
}

// ---------- 4. Tone.GrainPlayer (tono independiente de la velocidad) ----------
export class GrainEngine implements Engine {
  readonly id = 'grain' as const;
  private buf: Tone.ToneAudioBuffer;
  private g: Tone.GrainPlayer;
  private out: Tone.Gain;
  private t = new Track();
  private lock = true;
  private seeks = 0;

  constructor(audio: AudioBuffer, grainSize: number, overlap: number) {
    this.buf = new Tone.ToneAudioBuffer(audio);
    this.g = new Tone.GrainPlayer({ url: this.buf, grainSize, overlap });
    // GrainPlayer.stop() corta los granos con fadeOut 0 (clic). Este Gain hace el fundido antes de cada corte.
    this.out = new Tone.Gain(0).toDestination();
    this.g.connect(this.out);
  }
  get duration() { return this.buf.duration; }
  get playing() { return this.t.on; }
  // Los granos los programa un reloj de JS: hay que darle el margen del lookAhead (Tone.now()).
  // Rampas de volumen: bajar termina justo en `at` (el corte) y subir empieza ahí.
  private ramp(points: [number, number][]) {
    const gain = this.out.gain;
    gain.cancelScheduledValues(points[0][1]);
    gain.setValueAtTime(points[0][0], points[0][1]);
    for (const [v, t] of points.slice(1)) gain.linearRampToValueAtTime(v, t);
  }
  play() {
    if (this.t.on) return;
    const at = Tone.now(), off = Math.min(this.t.off, this.duration - 0.05);
    this.g.start(at, off);
    this.ramp([[0, at], [1, at + FADE]]);
    this.t.start(at, off);
  }
  pause() {
    if (!this.t.on) return;
    const at = Tone.now();
    this.ramp([[1, at - FADE], [0, at]]);
    this.g.stop(at);
    this.t.stop(at);
  }
  seek(t: number) {
    this.seeks++;
    if (!this.t.on) { this.t.off = t; return; }
    const at = Tone.now();
    this.ramp([[1, at - FADE], [0, at], [1, at + FADE]]); // baja 15 ms, salta en `at`, sube 15 ms
    this.g.restart(at, t);
    this.t.start(at, t);
  }
  setRate(r: number) {
    this.g.playbackRate = r; // cambia la frecuencia del reloj de granos en now(), sin cortar
    this.t.setRate(Tone.now(), r);
    this.applyPitch();
  }
  setPitchLock(on: boolean) { this.lock = on; this.applyPitch(); }
  private applyPitch() { this.g.detune = this.lock ? 0 : cents(this.t.rate); }
  tune(k: string, v: number) {
    if (k === 'grainSize') this.g.grainSize = v;
    if (k === 'overlap') this.g.overlap = v;
  }
  position() {
    const p = this.t.pos(ct());
    if (this.t.on && p >= this.duration) { this.t.stop(ct()); this.t.off = this.duration; }
    return Math.min(p, this.duration);
  }
  stats() {
    return {
      Seeks: String(this.seeks),
      'Granos/s': (this.t.rate / Number(this.g.grainSize)).toFixed(1),
      'RAM de audio': mb(this.buf.get()!),
    };
  }
  dispose() {
    this.g.stop();
    this.g.dispose();
    this.out.dispose();
    this.buf.dispose();
  }
}

/** Memoria de un AudioBuffer: muestras × canales × 4 bytes (Float32) */
export const bufferBytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;
export const mb = (b: AudioBuffer) => `${(bufferBytes(b) / 1e6).toFixed(0)} MB (${b.numberOfChannels} ch · ${b.sampleRate} Hz)`;

// ---------- 5. Signalsmith Stretch (AudioWorklet + WASM) ----------
// Corre en el hilo de audio en tiempo real. Cambiar BPM o posición es un mensaje (schedule):
// no se recrea ningún nodo ni se vacía ningún búfer, y el tono se conserva.

export class StretchEngine implements Engine {
  readonly id = 'stretch' as const;
  private t = new Track();
  private lock = true;
  private seeks = 0;
  private constructor(private ctx: AudioContext, private node: StretchNode, private out: GainNode, readonly duration: number, private mbs: string) {}

  static async create(ctx: AudioContext, audio: AudioBuffer) {
    const node = await SignalsmithStretch(ctx, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [audio.numberOfChannels] });
    const out = ctx.createGain();
    out.gain.value = 0;
    node.connect(out).connect(ctx.destination);
    node.configure({ splitComputation: true }); // reparte el cálculo: picos de CPU más bajos en el móvil
    const chans: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
    await node.addBuffers(chans);
    return new StretchEngine(ctx, node, out, audio.duration, mb(audio));
  }
  get playing() { return this.t.on; }
  private semis() { return this.lock ? 0 : 12 * Math.log2(this.t.rate); }
  private fade(to: number, at: number) {
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(to, at + FADE);
  }
  play() {
    if (this.t.on) return;
    const at = this.ctx.currentTime + 0.02, off = Math.min(this.t.off, this.duration - 0.05);
    this.node.schedule({ output: at, active: true, input: off, rate: this.t.rate, semitones: this.semis() });
    this.fade(1, at);
    this.t.start(at, off);
  }
  pause() {
    if (!this.t.on) return;
    const now = this.ctx.currentTime;
    this.fade(0, now);
    this.node.schedule({ output: now + FADE + 0.005, active: false });
    this.t.stop(now);
  }
  seek(t: number) {
    this.seeks++;
    if (!this.t.on) { this.t.off = t; return; }
    const at = this.ctx.currentTime;
    // Salto dentro del mismo nodo: el stretch hace el empalme con su propio solapamiento (sin silencio)
    this.node.schedule({ output: at, input: t, rate: this.t.rate, semitones: this.semis() });
    this.t.start(at, t);
  }
  setRate(r: number) {
    const at = this.ctx.currentTime;
    this.t.setRate(at, r);
    this.node.schedule({ output: at, rate: r, semitones: this.semis() });
  }
  setPitchLock(on: boolean) { this.lock = on; this.setRate(this.t.rate); }
  tune(k: string, v: number) { if (k === 'cheaper') this.node.configure({ blockMs: null, preset: v ? 'cheaper' : 'default', splitComputation: true } as any); }
  position() {
    const p = this.t.pos(this.ctx.currentTime);
    if (this.t.on && p >= this.duration) this.pause();
    return Math.min(p, this.duration);
  }
  stats() {
    return { Seeks: String(this.seeks), 'RAM de audio': this.mbs };
  }
  dispose() {
    this.node.schedule({ active: false });
    this.node.dropBuffers().catch(() => {});
    this.node.disconnect();
    this.out.disconnect();
  }
}
