// Lector de audio continuo para MP3 largos: entrega PCM sin costuras desde cualquier segundo,
// decodificando tramos de ~20 s con el decodificador del navegador.
// Cada tramo se decodifica con frames de sobra, se alinea con el anterior por correlación y se une con un fundido corto.
import type { Mp3Index } from './mp3-index';

const PRE = 8, POST = 6;          // frames extra antes/después de cada tramo
const XF = 256;                   // muestras de fundido en cada costura (~5 ms)
const WIN = 2048, SEARCH = 1600;  // ventana y rango de búsqueda de la correlación
export const CHUNK_SEC = 20;

const decode = (ctx: BaseAudioContext, bytes: ArrayBuffer) => new Promise<AudioBuffer>((res, rej) => {
  const p = ctx.decodeAudioData(bytes, res, rej); // callbacks y promesa: algunos Safari solo cumplen una
  (p as any)?.then?.(res, rej);
});
export const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

const mono = (b: AudioBuffer) => {
  const a = b.getChannelData(0);
  if (b.numberOfChannels < 2) return a;
  const c = b.getChannelData(1), m = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = (a[i] + c[i]) * 0.5;
  return m;
};

function align(x: Float32Array, ref: Float32Array, from: number, to: number) {
  let rr = 0;
  for (let j = 0; j < ref.length; j += 2) rr += ref[j] * ref[j];
  if (rr < 1e-6) return { at: -1, q: 0 }; // silencio: nada que alinear
  let best = -1, bestC = -Infinity;
  for (let lag = Math.max(0, from); lag <= to && lag + ref.length <= x.length; lag++) {
    let xr = 0, xx = 0;
    for (let j = 0; j < ref.length; j += 2) { const v = x[lag + j]; xr += v * ref[j]; xx += v * v; }
    const c = xr / Math.sqrt(xx * rr + 1e-12);
    if (c > bestC) { bestC = c; best = lag; }
  }
  return { at: best, q: bestC };
}

export class Mp3Pcm {
  /** Retraso fijo del decodificador del navegador (muestras); se mide en la primera costura */
  delay = 0;
  joins = 0; goodJoins = 0; lastDecodeMs = 0;
  readonly duration: number;
  private spfOut: number;
  private chunkFrames: number;

  /** ctx: contexto con el que se decodifica (puede ser un OfflineAudioContext); su sampleRate es el de salida */
  constructor(private ctx: BaseAudioContext, private blob: Blob, private idx: Mp3Index) {
    this.duration = (idx.count * idx.spf) / idx.sr;
    this.spfOut = (idx.spf * ctx.sampleRate) / idx.sr;
    this.chunkFrames = Math.round((CHUNK_SEC * idx.sr) / idx.spf);
  }

  /** Segundo exacto donde empieza el frame que contiene `t` */
  frameStart(t: number) {
    const f = Math.max(0, Math.min(this.idx.count - 1, Math.floor((t * this.idx.sr) / this.idx.spf)));
    return { f, t: (f * this.idx.spf) / this.idx.sr };
  }

  /**
   * Lee PCM contiguo (estéreo, a la frecuencia del contexto) desde el frame que contiene `t`
   * hasta juntar `seconds` o llegar al final. Entrega cada pedazo a `sink` en orden.
   */
  async read(t: number, seconds: number, sink: (chans: Float32Array[]) => void, cancelled: () => boolean) {
    const { offsets, count, end } = this.idx;
    const start = this.frameStart(t);
    let next = start.f, got = 0;
    let prevRef: Float32Array | null = null, tail: Float32Array[] | null = null;
    const need = seconds * this.ctx.sampleRate;
    while (next < count && got < need) {
      const f0 = next, f1 = Math.min(count, f0 + this.chunkFrames);
      const a = Math.max(0, f0 - PRE), b = Math.min(count, f1 + POST);
      const t0 = performance.now();
      const bytes = await this.blob.slice(offsets[a], b < count ? offsets[b] : end).arrayBuffer();
      const buf = await withTimeout(decode(this.ctx, bytes), 15000, 'el navegador no terminó de decodificar un tramo en 15 s');
      this.lastDecodeMs = performance.now() - t0;
      if (cancelled()) return null;

      const m = mono(buf);
      const guess = (f0 - a) * this.spfOut + this.delay;
      let s = Math.round(guess);
      if (prevRef) {
        this.joins++;
        const range = this.goodJoins ? 96 : SEARCH; // con el retraso ya medido se busca cerca
        const r = align(m, prevRef, Math.round(guess - WIN / 2 - range), Math.round(guess - WIN / 2 + range));
        if (r.q > 0.6) { s = r.at + WIN / 2; this.delay = s - (f0 - a) * this.spfOut; this.goodJoins++; }
      }
      const last = f1 >= count;
      const e = last ? buf.length : Math.min(buf.length, Math.round(s + (f1 - f0) * this.spfOut));
      const keep = last ? 0 : XF;
      const chans: Float32Array[] = [], newTail: Float32Array[] = [];
      for (let c = 0; c < 2; c++) {
        const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const seg = src.slice(Math.max(0, tail ? s - XF : s), e - keep);
        if (tail) for (let j = 0; j < XF && j < seg.length; j++) { const w = j / XF; seg[j] = tail[c][j] * (1 - w) + seg[j] * w; }
        chans.push(seg);
        newTail.push(src.slice(e - keep, e));
      }
      prevRef = last ? null : m.slice(e - WIN / 2, e + WIN / 2);
      tail = last ? null : newTail;
      next = f1;
      got += chans[0].length;
      sink(chans);
    }
    return { start: start.t, eof: next >= count };
  }
}
