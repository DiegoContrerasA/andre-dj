// Tone.js (GrainPlayer / Player) para MP3 de cualquier duración, con "ventanas" que se relevan.
//
// Tone necesita el audio en un AudioBuffer, pero un mix de 1–2 h descomprimido son 1,5–3 GB.
// Aquí suena una ventana de ~3 min; mientras tanto se prepara la siguiente, que empieza 20 s antes de que
// termine la actual. A mitad de ese solapamiento las dos tienen exactamente el mismo audio en el mismo punto,
// y se cruzan con un fundido de 30 ms: no se nota. RAM: ~70–150 MB sea cual sea la duración.
import * as Tone from 'tone';
import { FADE, Track, type Engine, type EngineId } from './engines';
import { CHUNK_SEC, Mp3Pcm } from './pcm';
import type { Mp3Index } from './stream';

const WINDOW_SEC = 180;   // largo de cada ventana
const OVERLAP_SEC = 20;   // la siguiente empieza esto antes del final de la actual
const PREPARE_SEC = 70;   // se empieza a preparar la siguiente cuando falta esto para el final
const BACK_SEC = 15;      // margen hacia atrás al cargar por un seek (para los −10 s)
const XFADE = 0.03;       // fundido del relevo

export type ToneMode = 'grain' | 'player' | 'player-ps';
type Opts = { grainSize: number; overlap: number; windowSize: number };
type Win = {
  raw: AudioBuffer; buf: Tone.ToneAudioBuffer; start: number; end: number; eof: boolean;
  src: Tone.Player | Tone.GrainPlayer; gain: Tone.Gain;
};

const cents = (r: number) => 1200 * Math.log2(r);
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class WindowedToneEngine implements Engine {
  readonly id: EngineId;
  readonly duration: number;
  private pcm: Mp3Pcm;
  private t = new Track();
  private lock = true;
  private seeks = 0; private swaps = 0;
  private cur: Win | null = null;
  private next: Win | null = null;
  private building = false;
  private gen = 0;
  private wantPlay = false;
  private waiting = false;
  private bus: Tone.Gain;
  private ps: Tone.PitchShift | null = null;
  private timer: number;
  private lastBuildMs = 0;

  private constructor(private raw: AudioContext, blob: Blob, idx: Mp3Index, private mode: ToneMode, private opts: Opts, private onStatus: (s: string) => void) {
    this.id = mode;
    this.pcm = new Mp3Pcm(raw, blob, idx);
    this.duration = this.pcm.duration;
    this.bus = new Tone.Gain(1);
    if (mode === 'player-ps') { this.ps = new Tone.PitchShift({ windowSize: opts.windowSize }); this.bus.chain(this.ps, Tone.getDestination()); }
    else this.bus.toDestination();
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  static async create(raw: AudioContext, blob: Blob, idx: Mp3Index, mode: ToneMode, opts: Opts, onStatus: (s: string) => void) {
    const e = new WindowedToneEngine(raw, blob, idx, mode, opts, onStatus);
    if (!(await e.load(0))) throw new Error('no se pudo preparar el audio');
    return e;
  }

  // ---------- Ventanas ----------
  private async build(from: number, gen: number): Promise<Win | null> {
    const sr = this.raw.sampleRate;
    const max = Math.ceil((WINDOW_SEC + CHUNK_SEC + 1) * sr);
    const raw = this.raw.createBuffer(2, max, sr);
    let w = 0;
    const t0 = performance.now();
    const r = await this.pcm.read(from, WINDOW_SEC, (ch) => {
      const n = Math.min(ch[0].length, max - w);
      if (n <= 0) return;
      raw.copyToChannel(ch[0].subarray(0, n), 0, w);
      raw.copyToChannel(ch[1].subarray(0, n), 1, w);
      w += n;
    }, () => gen !== this.gen);
    if (!r || gen !== this.gen) return null;
    this.lastBuildMs = performance.now() - t0;
    const buf = new Tone.ToneAudioBuffer(raw);
    const gain = new Tone.Gain(0).connect(this.bus);
    let src: Tone.Player | Tone.GrainPlayer;
    if (this.mode === 'grain') src = new Tone.GrainPlayer({ url: buf, grainSize: this.opts.grainSize, overlap: this.opts.overlap });
    else { const p = new Tone.Player(buf); p.fadeIn = FADE; p.fadeOut = FADE; src = p; }
    src.connect(gain);
    const win: Win = { raw, buf, start: r.start, end: r.start + w / sr, eof: r.eof, src, gain };
    this.applyRate(win);
    return win;
  }

  private free(w: Win | null) {
    if (!w) return;
    try { w.src.stop(); } catch {}
    w.src.dispose(); w.gain.dispose(); w.buf.dispose();
  }

  /** Carga una ventana alrededor de `t` (inicio o seek lejano). true cuando ya se puede sonar. */
  private async load(t: number) {
    const gen = ++this.gen;
    this.waiting = true;
    this.free(this.next); this.next = null;
    this.onStatus(`Decodificando desde ${fmtT(t)}…`);
    const w = await this.build(Math.max(0, t - BACK_SEC), gen);
    if (!w) return false;
    const old = this.cur;
    this.cur = w;
    this.waiting = false;
    this.onStatus('');
    if (old) setTimeout(() => this.free(old), 500);
    return true;
  }

  // ---------- Programación ----------
  /** Momento para arrancar: GrainPlayer necesita el margen del lookAhead de Tone; el Player no */
  private when() { return this.mode === 'grain' ? Tone.now() : this.raw.currentTime + 0.03; }

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
    w.src.stop(Math.max(at + fade + 0.01, this.mode === 'grain' ? Tone.now() : 0));
  }

  private tick() {
    const cur = this.cur;
    if (!cur || this.waiting) return;
    const now = this.raw.currentTime;
    const pos = this.t.pos(now);
    if (this.t.on && pos >= this.duration - 0.05) { this.pause(); this.t.off = this.duration; return; }

    // Preparar la siguiente ventana con tiempo
    if (!cur.eof && !this.next && !this.building && pos > cur.end - PREPARE_SEC) {
      const gen = this.gen;
      this.building = true;
      this.build(cur.end - OVERLAP_SEC, gen)
        .then((w) => { if (w && gen === this.gen && this.cur === cur) this.next = w; else this.free(w); })
        .catch((e) => this.onStatus(`Error al decodificar: ${e?.message || e}`))
        .finally(() => (this.building = false));
    }

    // Relevo a mitad del solapamiento, programado con precisión en el reloj de audio
    const swapAt = cur.end - OVERLAP_SEC / 2;
    if (this.t.on && this.next && pos >= this.next.start + 1) {
      const left = (swapAt - pos) / this.t.rate;
      if (left < 0.5) {
        const at = Math.max(now + Math.max(0, left), this.when() + 0.01);
        const songT = this.t.pos(at);
        const nw = this.next;
        this.next = null;
        this.startW(nw, at, songT, XFADE);
        this.stopW(cur, at, XFADE);
        this.cur = nw;
        this.swaps++;
        setTimeout(() => this.free(cur), (at - now + XFADE + 1) * 1000);
      }
    }

    // Si la siguiente no llegó a tiempo (decodificación lenta): se recarga donde va, sin dejarlo mudo
    if (this.t.on && !this.next && !cur.eof && pos > cur.end - 1) {
      this.onStatus('Esperando decodificación…');
      this.seek(pos);
    }
  }

  // ---------- Interfaz del motor ----------
  get playing() { return this.t.on || (this.waiting && this.wantPlay); }

  play() {
    this.wantPlay = true;
    if (this.t.on || this.waiting || !this.cur) return;
    const at = this.when();
    const songT = Math.min(Math.max(this.t.off, this.cur.start), this.cur.end - 0.1);
    this.startW(this.cur, at, songT);
    this.t.start(at, songT);
  }

  pause() {
    this.wantPlay = false;
    if (!this.t.on || !this.cur) return;
    const now = this.raw.currentTime;
    this.stopW(this.cur, now);
    this.t.stop(now);
  }

  seek(t: number) {
    this.seeks++;
    t = Math.min(this.duration - 0.25, Math.max(0, t));
    const cur = this.cur;
    if (!this.waiting && cur && t >= cur.start && t < cur.end - 1) {
      if (!this.t.on) { this.t.off = t; return; }
      const at = this.when();
      if (cur.src instanceof Tone.Player) cur.src.seek(t - cur.start, at); // fundido cruzado propio de Tone
      else { this.ramp(cur.gain, [[1, at - FADE], [0, at], [1, at + FADE]]); cur.src.restart(at, t - cur.start); }
      this.t.start(at, t);
      return;
    }
    const nx = this.next;
    if (!this.waiting && cur && nx && t >= nx.start && t < nx.end - 1) {
      // El destino ya está en la siguiente ventana: se pasa a ella
      this.next = null;
      if (this.t.on) { const at = this.when(); this.stopW(cur, this.raw.currentTime); this.startW(nx, at, t); this.t.start(at, t); }
      else this.t.off = t;
      this.cur = nx;
      setTimeout(() => this.free(cur), 500);
      return;
    }
    // Lejos: se carga una ventana nueva y se sigue desde ahí
    const keepPlaying = this.t.on || this.wantPlay;
    if (this.t.on && cur) { const now = this.raw.currentTime; this.stopW(cur, now); this.t.stop(now); }
    this.t.off = t;
    this.wantPlay = keepPlaying;
    this.load(t).then((ok) => { if (ok && this.wantPlay && !this.t.on) this.play(); })
      .catch((e) => this.onStatus(`No se pudo saltar: ${e?.message || e}`));
  }

  private applyRate(w: Win) {
    const r = this.t.rate;
    w.src.playbackRate = r;
    if (w.src instanceof Tone.GrainPlayer) w.src.detune = this.lock ? 0 : cents(r);
  }
  setRate(r: number) {
    this.t.setRate(this.mode === 'grain' ? Tone.now() : this.raw.currentTime, r);
    if (this.cur) this.applyRate(this.cur);
    if (this.next) this.applyRate(this.next);
    if (this.ps) this.ps.pitch = this.lock ? -cents(r) / 100 : 0;
  }
  setPitchLock(on: boolean) { this.lock = on; this.setRate(this.t.rate); }
  tune(k: string, v: number) {
    if (k === 'windowSize' && this.ps) this.ps.windowSize = v;
    if (k === 'grainSize' || k === 'overlap') {
      this.opts[k] = v;
      for (const w of [this.cur, this.next]) if (w?.src instanceof Tone.GrainPlayer) w.src[k] = v;
    }
  }
  position() { return Math.min(this.t.pos(this.raw.currentTime), this.duration); }

  stats() {
    const ram = [this.cur, this.next].reduce((s, w) => s + (w ? w.raw.length * 2 * 4 : 0), 0);
    return {
      Seeks: String(this.seeks),
      'Ventana': this.cur ? `${fmtT(this.cur.start)} → ${fmtT(this.cur.end)}` : '—',
      'Siguiente': this.next ? `lista (${fmtT(this.next.start)})` : this.building ? 'preparando…' : '—',
      'Relevos': String(this.swaps),
      'RAM de audio': `${(ram / 1e6).toFixed(0)} MB`,
      'Preparar ventana': `${this.lastBuildMs.toFixed(0)} ms`,
      'Costuras alineadas': `${this.pcm.goodJoins}/${this.pcm.joins}`,
    };
  }

  dispose() {
    this.gen++;
    clearInterval(this.timer);
    this.free(this.cur); this.free(this.next);
    this.cur = this.next = null;
    this.bus.dispose(); this.ps?.dispose();
  }
}
