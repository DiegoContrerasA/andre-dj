// Contexto de audio único de la app (Web Audio + Tone.js). Solo existe en el cliente.
import * as Tone from 'tone';

let raw: AudioContext | null = null;

/** Crea el contexto la primera vez. Puede nacer suspendido: suena después de unlockAudio() en un toque. */
export function audioCtx() {
  if (!raw) {
    // 'playback': búferes más grandes = menos cortes en el celular. lookAhead 200 ms: margen para el reloj de granos.
    raw = new AudioContext({ latencyHint: 'playback' });
    const c = new Tone.Context(raw as any);
    c.lookAhead = 0.2;
    Tone.setContext(c, true);
    // Safari 16.4+: que el interruptor de silencio del iPhone no calle la música
    const session = (navigator as any).audioSession;
    if (session) try { session.type = 'playback'; } catch {}
  }
  return raw;
}

/** iOS solo deja arrancar (o reanudar tras una llamada/bloqueo) el audio dentro de un toque del usuario */
export function unlockAudio() {
  const c = audioCtx();
  if (c.state !== 'running') c.resume().catch(() => {});
}
