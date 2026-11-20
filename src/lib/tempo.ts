// Tempo compartido: velocidad de cada deck = BPM compartido / BPM base del deck.
// BPM base = el real si llega a 107–180 con ≤16% de ajuste; si no, su doble o mitad (como Rekordbox/Serato).
export const MIN_BPM = 107;
export const MAX_BPM = 180;

export const clampBpm = (b: number) => Math.min(MAX_BPM, Math.max(MIN_BPM, b));
export const inRange = (b: number) => b >= MIN_BPM && b <= MAX_BPM;
export const round1 = (b: number) => Math.round(b * 10) / 10;
const distToRange = (b: number) => (b < MIN_BPM ? Math.log(MIN_BPM / b) : b > MAX_BPM ? Math.log(b / MAX_BPM) : 0);

/**
 * 1) el original o su doble/mitad si cae en 107–180 (así "Original" = velocidad 1.0)
 * 2) si ninguno cae (ej. 95: 47.5/95/190), el original si está a ≤16%, o el candidato más cercano.
 */
export const baseBpm = (orig: number) => {
  const inside = [orig, orig * 2, orig / 2].find(inRange);
  if (inside) return inside;
  if (distToRange(orig) <= Math.log(1.16)) return orig;
  return [orig * 2, orig / 2].reduce((best, c) => (distToRange(c) < distToRange(best) ? c : best), orig);
};

/** Posición (0–100%) de un BPM sobre el fader */
export const posPct = (bpm: number) => ((clampBpm(bpm) - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 100;
