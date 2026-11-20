// Signalsmith Stretch "por tramos": reproduce MP3 de cualquier duración (mixes de 1–2 h) sin descomprimirlos enteros.
//
// 1. Índice: se recorren las cabeceras de los frames MP3 (sin decodificar) → byte exacto de cada instante (CBR o VBR).
// 2. Ventana: se decodifican tramos de ~20 s alrededor de la posición (≈90 s adelante, 30 s atrás) y se sueltan los viejos.
// 3. Empalme: cada tramo se decodifica con frames de sobra a ambos lados, se alinea con el anterior por correlación
//    y se une con un fundido de ~5 ms. Así no se oyen las costuras entre tramos.
// 4. El AudioWorklet de Signalsmith sigue sonando todo el tiempo: BPM y seeks son mensajes, nada se recrea.
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';
import { MP3_SR, findMp3Sync, mp3FrameLen } from '../../lib/audio/bpm-detect';
import { FADE, Track, type Engine } from './engines';

// ---------- Índice de frames ----------
export type Mp3Index = { offsets: Uint32Array; count: number; sr: number; spf: number; end: number };

const id3Size = (u: Uint8Array) =>
  u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33 ? 10 + ((u[6] << 21) | (u[7] << 14) | (u[8] << 7) | u[9]) + (u[5] & 0x10 ? 10 : 0) : 0;

/** null si no es MP3 */
export async function indexMp3(blob: Blob): Promise<Mp3Index | null> {
  const start = id3Size(new Uint8Array(await blob.slice(0, 10).arrayBuffer()));
  const probe = new Uint8Array(await blob.slice(start, start + 256 * 1024).arrayBuffer());
  const sync = findMp3Sync(probe);
  if (sync < 0) return null;
  const h = start + sync;
  const ver = (probe[sync + 1] >> 3) & 3, sri = (probe[sync + 2] >> 2) & 3;
  const sr = MP3_SR[ver][sri], spf = ver === 3 ? 1152 : 576;

  let offsets = new Uint32Array(Math.ceil(blob.size / 300) + 16); // ~300 bytes/frame a 128 kbps: casi nunca crece
  let count = 0, pos = h, end = blob.size;
  const SLICE = 4 << 20;
  let bufStart = -1, buf = new Uint8Array(0);
  while (pos + 4 <= blob.size) {
    if (pos + 4 > bufStart + buf.length || pos < bufStart) {
      bufStart = pos;
      buf = new Uint8Array(await blob.slice(pos, pos + SLICE).arrayBuffer());
    }
    const len = mp3FrameLen(buf, pos - bufStart);
    if (len) {
      if (count === offsets.length) { const o = new Uint32Array(count * 2); o.set(offsets); offsets = o; }
      offsets[count++] = pos;
      pos += len;
      continue;
    }
    // Basura o etiqueta al final (ID3v1 "TAG", APE…): buscar el siguiente frame válido
    const next = findMp3Sync(buf, pos - bufStart + 1);
    if (next < 0) {
      if (bufStart + buf.length >= blob.size) { end = pos; break; }
      pos = bufStart + Math.max(1, buf.length - 8); // seguir buscando en el siguiente pedazo
      bufStart = -1;
      continue;
    }
    pos = bufStart + next;
  }
  if (count < 2) return null;
  return { offsets: offsets.subarray(0, count), count, sr, spf, end: Math.min(end, blob.size) };
}

// ---------- Decodificación ----------
const decode = (ctx: BaseAudioContext, bytes: ArrayBuffer) => new Promise<AudioBuffer>((res, rej) => {
  // Forma con callbacks y con promesa: algunos Safari solo cumplen una de las dos
  const p = ctx.decodeAudioData(bytes, res, rej);
  (p as any)?.then?.(res, rej);
});
const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

const mono = (b: AudioBuffer) => {
  const a = b.getChannelData(0);
  if (b.numberOfChannels < 2) return a;
  const c = b.getChannelData(1), m = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = (a[i] + c[i]) * 0.5;
  return m;
};

/** Desplazamiento de `ref` dentro de `x` (correlación normalizada). Devuelve el índice y la calidad (0–1). */
function align(x: Float32Array, ref: Float32Array, from: number, to: number) {
  let best = -1, bestC = -Infinity;
  let rr = 0;
  for (let j = 0; j < ref.length; j++) rr += ref[j] * ref[j];
  if (rr < 1e-6) return { at: -1, q: 0 }; // silencio: no hay nada que alinear
  for (let lag = Math.max(0, from); lag <= to && lag + ref.length <= x.length; lag++) {
    let xr = 0, xx = 0;
    for (let j = 0; j < ref.length; j += 2) { const v = x[lag + j]; xr += v * ref[j]; xx += v * v; } // 1 de cada 2: el doble de rápido
    const c = xr / Math.sqrt(xx * (rr / 2) + 1e-12);
    if (c > bestC) { bestC = c; best = lag; }
  }
  return { at: best, q: bestC };
}

const PRE = 8;      // frames extra antes del tramo (reservorio de bits del MP3 + margen para alinear)
const POST = 6;     // frames extra después (zona compartida con el siguiente tramo)
const XF = 256;     // muestras de fundido en cada costura (~5 ms)
const WIN = 2048;   // ventana de correlación
const SEARCH = 1600;
const CHUNK_SEC = 20, AHEAD_SEC = 90, BEHIND_SEC = 30;

export class StreamStretchEngine implements Engine {
  readonly id = 'stretch' as const;
  readonly duration: number;
  private t = new Track();
  private lock = true;
  private seeks = 0;
  private gen = 0;
  /** Segundos de la canción que corresponden al instante 0 del búfer del stretch */
  private base = 0;
  private loadedFrom = 0;   // en segundos del búfer del stretch
  private loadedTo = 0;
  private nextFrame = 0;
  private tail: Float32Array[] | null = null; // últimas XF muestras del tramo anterior, para el fundido
  private prevRef: Float32Array | null = null;
  private prevEndIdx = 0;                      // dónde cae, dentro del tramo anterior, su frame final
  private delay = 0;                           // retraso del decodificador (se mide en la primera costura)
  private wantPlay = false;
  private starving = false;
  private waiting = false;
  private chunks = 0; private goodJoins = 0; private lastDecodeMs = 0;
  private spfOut: number;
  private chunkFrames: number;

  private constructor(private ctx: AudioContext, private node: StretchNode, private out: GainNode, private blob: Blob, private idx: Mp3Index, private onStatus: (s: string) => void) {
    this.duration = (idx.count * idx.spf) / idx.sr;
    this.spfOut = (idx.spf * ctx.sampleRate) / idx.sr;
    this.chunkFrames = Math.round((CHUNK_SEC * idx.sr) / idx.spf);
  }

  static async create(ctx: AudioContext, blob: Blob, idx: Mp3Index, onStatus: (s: string) => void) {
    if (!ctx.audioWorklet) throw new Error('Este navegador no permite AudioWorklet aquí (¿la página no es HTTPS?)');
    if (ctx.state !== 'running') throw new Error('El audio está suspendido: toca "Activar audio" otra vez');
    onStatus('Iniciando el motor de stretch…');
    const node = await withTimeout(SignalsmithStretch(ctx, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }), 10000,
      'El motor de stretch no arrancó en 10 s (AudioWorklet/WASM bloqueado)');
    const out = ctx.createGain();
    out.gain.value = 0;
    node.connect(out).connect(ctx.destination);
    node.configure({ splitComputation: true });
    const e = new StreamStretchEngine(ctx, node, out, blob, idx, onStatus);
    await e.restartAt(0);
    return e;
  }

  // ---------- Carga por tramos ----------
  /** Empieza a cargar desde el segundo `t` (seek lejano o inicio). Resuelve cuando ya hay audio para sonar. */
  private async restartAt(t: number) {
    const gen = ++this.gen;
    const f0 = Math.max(0, Math.min(this.idx.count - 1, Math.floor((t * this.idx.sr) / this.idx.spf)));
    this.base = (f0 * this.idx.spf) / this.idx.sr;
    this.loadedFrom = this.loadedTo = 0;
    this.nextFrame = f0;
    this.tail = this.prevRef = null;
    this.waiting = true;
    await this.node.dropBuffers();
    if (gen !== this.gen) return;
    this.onStatus(`Decodificando desde ${fmtT(this.base)}…`);
    await this.loadChunk(gen);
    if (gen !== this.gen) return;
    this.waiting = false;
    this.onStatus('');
    this.pump(gen);
  }

  /** Mantiene AHEAD_SEC cargados por delante y suelta lo que quedó BEHIND_SEC atrás */
  private async pump(gen: number) {
    while (gen === this.gen) {
      const local = this.t.pos(this.ctx.currentTime) - this.base;
      if (this.nextFrame < this.idx.count && this.loadedTo - local < AHEAD_SEC * Math.max(1, this.t.rate)) {
        try { await this.loadChunk(gen); } catch (e: any) { this.onStatus(`Error al decodificar: ${e?.message || e}`); await sleep(1000); }
        continue;
      }
      if (local - this.loadedFrom > BEHIND_SEC + CHUNK_SEC) {
        const r = await this.node.dropBuffers(local - BEHIND_SEC);
        if (gen === this.gen) this.loadedFrom = r.start;
      }
      await sleep(300);
    }
  }

  private async loadChunk(gen: number) {
    const { offsets, count, end } = this.idx;
    const f0 = this.nextFrame, f1 = Math.min(count, f0 + this.chunkFrames);
    const a = Math.max(0, f0 - PRE), b = Math.min(count, f1 + POST);
    const t0 = performance.now();
    const bytes = await this.blob.slice(offsets[a], b < count ? offsets[b] : end).arrayBuffer();
    const buf = await withTimeout(decode(this.ctx, bytes), 15000, 'el navegador no terminó de decodificar un tramo en 15 s');
    this.lastDecodeMs = performance.now() - t0;
    if (gen !== this.gen) return;

    const m = mono(buf);
    const guess = (f0 - a) * this.spfOut + this.delay;
    let start = Math.round(guess);
    if (this.prevRef) {
      // Alinear: el final del tramo anterior también está, solapado, al inicio de este
      // Ya medido el retraso del decodificador (es fijo), se busca cerca: evita engancharse a otro ciclo de un tono
      const range = this.goodJoins ? 96 : SEARCH;
      const r = align(m, this.prevRef, Math.round(guess - WIN / 2 - range), Math.round(guess - WIN / 2 + range));
      if (r.q > 0.6) {
        start = r.at + WIN / 2;
        this.delay = start - (f0 - a) * this.spfOut;
        this.goodJoins++;
      }
    }
    const last = f1 >= count;
    const endIdx = last ? buf.length : Math.min(buf.length, Math.round(start + (f1 - f0) * this.spfOut));
    const keep = last ? 0 : XF; // se guardan las últimas XF muestras para el fundido con el siguiente
    const chans: Float32Array[] = [];
    const newTail: Float32Array[] = [];
    for (let c = 0; c < 2; c++) {
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
      const from = this.tail ? start - XF : start;
      const seg = src.slice(Math.max(0, from), endIdx - keep);
      if (this.tail) for (let j = 0; j < XF && j < seg.length; j++) { const w = j / XF; seg[j] = this.tail[c][j] * (1 - w) + seg[j] * w; }
      chans.push(seg);
      newTail.push(src.slice(endIdx - keep, endIdx));
    }
    // Referencia para alinear el siguiente tramo: alrededor del frame final de este
    this.prevRef = last ? null : m.slice(endIdx - WIN / 2, endIdx + WIN / 2);
    this.prevEndIdx = endIdx;
    this.tail = last ? null : newTail;
    this.nextFrame = f1;
    this.chunks++;
    const to = await this.node.addBuffers(chans); // se transfieren al worklet (sin copia)
    if (gen === this.gen) this.loadedTo = to;
  }

  // ---------- Reproducción ----------
  get playing() { return this.t.on || (this.waiting && this.wantPlay); }
  private semis() { return this.lock ? 0 : 12 * Math.log2(this.t.rate); }
  private fade(to: number, at: number) {
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(to, at + FADE);
  }
  private startAt(songT: number) {
    const at = this.ctx.currentTime + 0.02;
    this.node.schedule({ output: at, active: true, input: songT - this.base, rate: this.t.rate, semitones: this.semis() });
    this.fade(1, at);
    this.t.start(at, songT);
  }
  play() {
    this.wantPlay = true;
    if (this.t.on || this.waiting) return; // si está cargando, arranca al terminar
    this.startAt(Math.min(this.t.off, this.duration - 0.05));
  }
  pause() {
    this.wantPlay = false;
    if (!this.t.on) return;
    const now = this.ctx.currentTime;
    this.fade(0, now);
    this.node.schedule({ output: now + FADE + 0.005, active: false });
    this.t.stop(now);
  }
  seek(t: number) {
    this.seeks++;
    const local = t - this.base;
    const inside = !this.waiting && local >= this.loadedFrom && local < this.loadedTo - 1;
    if (inside) {
      if (this.t.on) {
        const at = this.ctx.currentTime;
        this.node.schedule({ output: at, input: local, rate: this.t.rate, semitones: this.semis() });
        this.t.start(at, t);
      } else this.t.off = t;
      return;
    }
    // Fuera de lo cargado: silencio corto, se carga el tramo de destino y se sigue
    const was = this.wantPlay;
    if (this.t.on) { const now = this.ctx.currentTime; this.fade(0, now); this.node.schedule({ output: now + FADE + 0.005, active: false }); this.t.stop(now); }
    this.t.off = t;
    this.wantPlay = was;
    this.restartAt(t).then(() => { if (this.wantPlay && !this.t.on) this.startAt(Math.max(t, this.base)); });
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
    // Si la decodificación se atrasó y el stretch se quedó sin audio, se nota aquí
    const starving = this.t.on && p - this.base > this.loadedTo + 0.5 && this.nextFrame < this.idx.count;
    if (starving !== this.starving) { this.starving = starving; this.onStatus(starving ? 'Esperando decodificación…' : ''); }
    return Math.min(p, this.duration);
  }
  stats() {
    const ram = (this.loadedTo - this.loadedFrom) * this.ctx.sampleRate * 2 * 4;
    return {
      Seeks: String(this.seeks),
      'Cargado': `${fmtT(this.base + this.loadedFrom)} → ${fmtT(this.base + this.loadedTo)}`,
      'RAM de audio': `${(ram / 1e6).toFixed(0)} MB (ventana)`,
      'Tramos': `${this.chunks} · último ${this.lastDecodeMs.toFixed(0)} ms`,
      'Costuras alineadas': `${this.goodJoins}/${Math.max(0, this.chunks - 1)} · retraso ${this.delay.toFixed(0)}`,
    };
  }
  dispose() {
    this.gen++;
    this.node.schedule({ active: false });
    this.node.dropBuffers().catch(() => {});
    this.node.disconnect();
    this.out.disconnect();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
