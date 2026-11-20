// Motores de reproducción de un deck. Misma interfaz para los dos:
// - GrainEngine: Tone.GrainPlayer por ventanas (MP3 de cualquier duración, BPM sin cortes, tono conservado)
// - MediaEngine: <audio> del navegador (respaldo para M4A/WAV/FLAC/OGG, que no se pueden cortar por tramos)
import * as Tone from 'tone';
import { audioCtx } from './context';
import { FADE, Track } from './track';
import { CHUNK_SEC, Mp3Pcm } from './pcm';
import type { Mp3Index } from './mp3-index';

export interface DeckEngine {
  readonly kind: 'grain' | 'media';
  /** Segundos; 0 mientras no se sabe */
  readonly duration: number;
  readonly playing: boolean;
  /** Preparando audio (no puede sonar todavía) */
  readonly loading: boolean;
  play(): void;
  pause(): void;
  seek(t: number): void;
  position(): number;
  setRate(r: number): void;
  setPitchLock(on: boolean): void;
  dispose(): void;
  /** Cambió playing / loading / duration / terminó */
  onchange?: () => void;
  /** Error para mostrar al usuario */
  onerror?: (msg: string) => void;
}

const cents = (r: number) => 1200 * Math.log2(r);

// ======================= <audio> (respaldo) =======================
export class MediaEngine implements DeckEngine {
  readonly kind = 'media' as const;
  onchange?: () => void;
  onerror?: (msg: string) => void;
  private url: string;
  private target: number | null = null;
  private queued = false;
  private seekAt = 0;
  private off: () => void;

  constructor(private a: HTMLAudioElement, blob: Blob) {
    this.url = URL.createObjectURL(blob);
    a.src = this.url;
    const changed = () => this.onchange?.();
    const seeked = () => {
      // Un solo seek a la vez: si llegaron más mientras tanto, se aplica el último
      if (this.queued && this.target != null) { this.queued = false; this.seekAt = performance.now(); a.currentTime = this.target; return; }
      this.target = null;
      this.onchange?.();
    };
    const evs = ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange'];
    evs.forEach((e) => a.addEventListener(e, changed));
    a.addEventListener('seeked', seeked);
    this.off = () => { evs.forEach((e) => a.removeEventListener(e, changed)); a.removeEventListener('seeked', seeked); };
  }
  get duration() { return isFinite(this.a.duration) ? this.a.duration : 0; }
  get playing() { return !this.a.paused; }
  get loading() { return false; }
  play() { this.a.play().catch((e) => { if (e?.name !== 'AbortError') this.onerror?.(`No se pudo reproducir (${e?.name || e})`); }); }
  pause() { this.a.pause(); }
  seek(t: number) {
    if (!this.duration) return;
    this.target = t;
    if (this.a.seeking && performance.now() - this.seekAt < 1000) { this.queued = true; return; }
    this.queued = false;
    this.seekAt = performance.now();
    this.a.currentTime = t;
  }
  position() { return this.target ?? this.a.currentTime; }
  setRate(r: number) {
    if (Math.abs(this.a.playbackRate - r) > 1e-4) this.a.playbackRate = r;
    if (Math.abs(this.a.defaultPlaybackRate - r) > 1e-4) this.a.defaultPlaybackRate = r;
  }
  setPitchLock(on: boolean) { this.a.preservesPitch = on; (this.a as any).webkitPreservesPitch = on; }
  dispose() {
    this.off();
    this.a.pause();
    this.a.removeAttribute('src');
    this.a.load();
    URL.revokeObjectURL(this.url);
  }
}

// ======================= Tone.GrainPlayer por ventanas =======================
// Tone necesita el audio descomprimido en un AudioBuffer; un mix de 1–2 h serían 1,5–3 GB.
// Suena una ventana de ~2,5 min; mientras tanto se prepara la siguiente, que empieza 20 s antes del final
// de la actual. A mitad de ese solapamiento las dos tienen el mismo audio en el mismo punto y se cruzan
// con un fundido de 30 ms. RAM: ~70 MB por deck (~140 MB en el relevo), dure lo que dure el mix.
const WINDOW_SEC = 150;
const OVERLAP_SEC = 20;
const PREPARE_SEC = 70;   // se prepara la siguiente cuando falta esto para el final de la actual
const BACK_SEC = 15;      // margen hacia atrás al cargar por un seek (para los −10 s)
const XFADE = 0.03;
const GRAIN = { grainSize: 0.12, overlap: 0.06 };

type Win = { raw: AudioBuffer; buf: Tone.ToneAudioBuffer; start: number; end: number; eof: boolean; src: Tone.GrainPlayer; gain: Tone.Gain };

export class GrainEngine implements DeckEngine {
  readonly kind = 'grain' as const;
  readonly duration: number;
  onchange?: () => void;
  onerror?: (msg: string) => void;
  private ctx: AudioContext;
  private pcm: Mp3Pcm;
  private t = new Track();
  private lock = true;
  private cur: Win | null = null;
  private next: Win | null = null;
  private building = false;
  private gen = 0;
  private wantPlay = false;
  private waiting = true;
  private bus: Tone.Gain;
  private timer: number;
  private disposed = false;

  constructor(blob: Blob, idx: Mp3Index) {
    this.ctx = audioCtx();
    // Se decodifica con un OfflineAudioContext: funciona aunque el audio aún no esté desbloqueado (iOS)
    const Off = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    this.pcm = new Mp3Pcm(new Off(2, 1, this.ctx.sampleRate), blob, idx);
    this.duration = this.pcm.duration;
    this.bus = new Tone.Gain(1).toDestination();
    this.timer = window.setInterval(() => this.tick(), 100);
    this.load(0);
  }

  get playing() { return this.t.on || (this.waiting && this.wantPlay); }
  get loading() { return this.waiting; }
  private emit() { if (!this.disposed) this.onchange?.(); }

  // ---------- Ventanas ----------
  private async build(from: number, gen: number): Promise<Win | null> {
    const sr = this.ctx.sampleRate;
    const max = Math.ceil((WINDOW_SEC + CHUNK_SEC + 1) * sr);
    const raw = this.ctx.createBuffer(2, max, sr);
    let w = 0;
    const r = await this.pcm.read(from, WINDOW_SEC, (ch) => {
      const n = Math.min(ch[0].length, max - w);
      if (n <= 0) return;
      raw.copyToChannel(ch[0].subarray(0, n) as Float32Array<ArrayBuffer>, 0, w);
      raw.copyToChannel(ch[1].subarray(0, n) as Float32Array<ArrayBuffer>, 1, w);
      w += n;
    }, () => gen !== this.gen);
    if (!r || gen !== this.gen) return null;
    const buf = new Tone.ToneAudioBuffer(raw);
    const gain = new Tone.Gain(0).connect(this.bus);
    const src = new Tone.GrainPlayer({ url: buf, ...GRAIN }).connect(gain);
    const win: Win = { raw, buf, start: r.start, end: r.start + w / sr, eof: r.eof, src, gain };
    this.applyRate(win);
    return win;
  }

  private free(w: Win | null) {
    if (!w) return;
    try { w.src.stop(); } catch {}
    w.src.dispose(); w.gain.dispose(); w.buf.dispose();
  }

  /** Carga una ventana alrededor de `t` (al abrir la canción o por un seek lejano) */
  private async load(t: number) {
    const gen = ++this.gen;
    this.waiting = true;
    this.free(this.next); this.next = null;
    this.emit();
    let w: Win | null = null;
    try { w = await this.build(Math.max(0, t - BACK_SEC), gen); }
    catch (e: any) { if (gen === this.gen) { this.waiting = false; this.wantPlay = false; this.emit(); this.onerror?.(`No se pudo leer el audio: ${e?.message || e}`); } return; }
    if (!w) return; // llegó otro seek mientras tanto
    const old = this.cur;
    this.cur = w;
    this.waiting = false;
    if (old) setTimeout(() => this.free(old), 500);
    if (this.wantPlay) this.startNow();
    this.emit();
  }

  // ---------- Programación ----------
  /** GrainPlayer lo programa un reloj de JS: hay que darle el margen del lookAhead (Tone.now()) */
  private ramp(g: Tone.Gain, pts: [number, number][]) {
    const p = g.gain;
    p.cancelScheduledValues(pts[0][1]);
    p.setValueAtTime(pts[0][0], pts[0][1]);
    for (const [v, t] of pts.slice(1)) p.linearRampToValueAtTime(v, t);
  }
  private startW(w: Win, at: number, songT: number, fade = FADE) {
    w.src.start(at, Math.max(0, songT - w.start));
    this.ramp(w.gain, [[0, at], [1, at + fade]]);
  }
  private stopW(w: Win, at: number, fade = FADE) {
    this.ramp(w.gain, [[1, at], [0, at + fade]]);
    w.src.stop(Math.max(at + fade + 0.01, Tone.now()));
  }
  private startNow() {
    const cur = this.cur;
    if (!cur || this.t.on) return;
    const at = Tone.now();
    const songT = Math.min(Math.max(this.t.off, cur.start), cur.end - 0.1);
    this.startW(cur, at, songT);
    this.t.start(at, songT);
  }

  private tick() {
    const cur = this.cur;
    if (!cur || this.waiting) return;
    const now = this.ctx.currentTime;
    const pos = this.t.pos(now);
    if (this.t.on && pos >= this.duration - 0.05) { this.pause(); this.t.off = this.duration; this.emit(); return; }

    // Preparar la siguiente ventana con tiempo
    if (this.t.on && !cur.eof && !this.next && !this.building && pos > cur.end - PREPARE_SEC) {
      const gen = this.gen;
      this.building = true;
      this.build(cur.end - OVERLAP_SEC, gen)
        .then((w) => { if (w && gen === this.gen && this.cur === cur) this.next = w; else this.free(w); })
        .catch((e) => this.onerror?.(`Error al decodificar: ${e?.message || e}`))
        .finally(() => (this.building = false));
    }

    // Relevo a mitad del solapamiento, programado en el reloj de audio
    const swapAt = cur.end - OVERLAP_SEC / 2;
    if (this.t.on && this.next && pos >= this.next.start + 1) {
      const left = (swapAt - pos) / this.t.rate;
      if (left < 0.5) {
        const at = Math.max(now + Math.max(0, left), Tone.now() + 0.01);
        const songT = this.t.pos(at);
        const nw = this.next;
        this.next = null;
        this.startW(nw, at, songT, XFADE);
        this.stopW(cur, at, XFADE);
        this.cur = nw;
        setTimeout(() => this.free(cur), (at - now + XFADE + 1) * 1000);
      }
    }

    // La siguiente no llegó a tiempo (decodificación lenta): se recarga donde va
    if (this.t.on && !this.next && !cur.eof && pos > cur.end - 1) this.seek(pos);
  }

  // ---------- Interfaz ----------
  play() {
    this.wantPlay = true;
    if (this.t.off >= this.duration - 0.3) this.seek(0); // terminó: vuelve a empezar, como <audio>
    if (!this.waiting) this.startNow();
    this.emit();
  }

  pause() {
    this.wantPlay = false;
    if (this.t.on && this.cur) {
      const now = this.ctx.currentTime;
      this.stopW(this.cur, now);
      this.t.stop(now);
    }
    this.emit();
  }

  seek(t: number) {
    t = Math.min(this.duration - 0.25, Math.max(0, t));
    const cur = this.cur;
    if (!this.waiting && cur && t >= cur.start && t < cur.end - 1) {
      if (!this.t.on) { this.t.off = t; return; }
      const at = Tone.now();
      this.ramp(cur.gain, [[1, at - FADE], [0, at], [1, at + FADE]]); // baja 15 ms, salta, sube 15 ms
      cur.src.restart(at, t - cur.start);
      this.t.start(at, t);
      return;
    }
    const nx = this.next;
    if (!this.waiting && cur && nx && t >= nx.start && t < nx.end - 1) {
      this.next = null;
      if (this.t.on) { const at = Tone.now(); this.stopW(cur, this.ctx.currentTime); this.startW(nx, at, t); this.t.start(at, t); }
      else this.t.off = t;
      this.cur = nx;
      setTimeout(() => this.free(cur), 500);
      return;
    }
    // Fuera de lo cargado: se carga una ventana en el destino y sigue sonando desde ahí
    if (this.t.on && cur) { const now = this.ctx.currentTime; this.stopW(cur, now); this.t.stop(now); this.wantPlay = true; }
    this.t.off = t;
    this.load(t);
  }

  position() { return Math.min(this.t.pos(this.ctx.currentTime), this.duration); }

  private applyRate(w: Win) {
    w.src.playbackRate = this.t.rate;
    w.src.detune = this.lock ? 0 : cents(this.t.rate); // con "mantener tono" apagado, el tono sigue a la velocidad
  }
  setRate(r: number) {
    if (Math.abs(r - this.t.rate) < 1e-4) return;
    this.t.setRate(Tone.now(), r);
    if (this.cur) this.applyRate(this.cur);
    if (this.next) this.applyRate(this.next);
  }
  setPitchLock(on: boolean) {
    this.lock = on;
    if (this.cur) this.applyRate(this.cur);
    if (this.next) this.applyRate(this.next);
  }

  dispose() {
    this.disposed = true;
    this.gen++;
    clearInterval(this.timer);
    this.free(this.cur); this.free(this.next);
    this.cur = this.next = null;
    this.bus.dispose();
  }
}
