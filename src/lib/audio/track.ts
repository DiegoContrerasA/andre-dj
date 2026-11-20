// Reloj de posición de una fuente Web Audio: posición = offset + (t − t0) · rate
export const FADE = 0.015; // 15 ms: evita clics al cortar, demasiado corto para notarse

export class Track {
  off = 0; t0 = 0; rate = 1; on = false;
  pos(now: number) { return this.on ? this.off + Math.max(0, now - this.t0) * this.rate : this.off; }
  start(at: number, off: number) { this.off = off; this.t0 = at; this.on = true; }
  stop(now: number) { this.off = this.pos(now); this.on = false; }
  setRate(at: number, r: number) { if (this.on) { this.off = this.pos(at); this.t0 = at; } this.rate = r; }
}
