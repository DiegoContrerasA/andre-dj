// Controlador de /lab: misma canción, mismo BPM y mismos controles para cada motor.
import * as Tone from 'tone';
import { $, fmt, ls, toast } from '../../lib/dom';
import { dbAll } from '../../lib/db';
import { baseBpm, round1 } from '../../lib/tempo';
import { AudioEngine, GrainEngine, PlayerEngine, StretchEngine, bufferBytes, type Engine, type EngineId } from './engines';
import { StreamStretchEngine, indexMp3 } from './stream';

/** Por encima de esto no se decodifica: un AudioBuffer así puede hacer que iOS cierre la página */
const RAM_LIMIT = 450e6;

const NOTES: Record<EngineId, string> = {
  stretch: 'Signalsmith Stretch en un AudioWorklet (hilo de audio). BPM y seek son mensajes al mismo nodo: nada se recrea. Conserva el tono. Los MP3 se cargan por tramos: sirve para mixes completos. Prueba "BPM al soltar" apagado.',
  audio: 'El de la app. Tono conservado por Safari/Chrome (buena calidad). Lee el archivo en streaming: casi no usa RAM.',
  grain: 'Conserva el tono con granos. Prueba granos de 0.08–0.15 s y overlap ~la mitad. Más lookAhead = menos cortes, más retraso al tocar.',
  player: 'Seek y BPM muy suaves, pero el tono sube y baja con la velocidad ("Mantener tono" no aplica).',
  'player-ps': 'Player + PitchShift de Tone para compensar el tono. Ventana más chica = menos eco, más metálico.',
};

type Src = { blob: Blob; title: string; bpm: number | null };
const sources = new Map<string, Src>();
let src: Src | null = null;
let engine: Engine | null = null;
let engineId: EngineId = 'audio';
let unlocked = false;
let ctxKey = '';
let buildToken = 0;
let cache: { blob: Blob; buf: AudioBuffer } | null = null;
let decodeMs = 0;

const el = {
  src: $<HTMLSelectElement>('src'), file: $<HTMLInputElement>('file'),
  latency: $<HTMLSelectElement>('latency'), lookAhead: $<HTMLSelectElement>('lookAhead'), unlock: $<HTMLButtonElement>('unlock'),
  grainSize: $<HTMLInputElement>('grainSize'), overlap: $<HTMLInputElement>('overlap'), windowSize: $<HTMLInputElement>('windowSize'),
  fader: $<HTMLInputElement>('fader'), onRelease: $<HTMLInputElement>('onRelease'), lock: $<HTMLInputElement>('lock'),
  pp: $<HTMLButtonElement>('pp'), prog: $('prog'), stats: $('stats'),
};

// ---------- BPM ----------
const base = () => (src?.bpm ? baseBpm(src.bpm) : 128);
let applied = ls.get<number>('sharedBpm', 128);
const rate = (bpm: number) => bpm / base();
function paintBpm() {
  const shown = +el.fader.value;
  $('bpmOut').textContent = shown.toFixed(1);
  $('rateOut').textContent = `${rate(applied).toFixed(3)}× sonando`;
  $('pendingOut').textContent = Math.abs(shown - applied) > 0.05 ? `al soltar → ${rate(shown).toFixed(3)}×` : '';
}
function applyBpm(bpm: number) {
  applied = round1(bpm);
  engine?.setRate(rate(applied));
  paintBpm();
}
let faderRaf = 0, dragging = false;
el.fader.addEventListener('input', () => {
  dragging = true;
  if (faderRaf) return;
  faderRaf = requestAnimationFrame(() => {
    faderRaf = 0;
    if (el.onRelease.checked) paintBpm(); // solo se ve; la música sigue igual
    else applyBpm(+el.fader.value);
  });
});
const commitBpm = () => { if (!dragging) return; dragging = false; applyBpm(+el.fader.value); };
['change', 'touchend', 'touchcancel', 'pointerup', 'pointercancel'].forEach((ev) => el.fader.addEventListener(ev, commitBpm));
el.lock.addEventListener('change', () => engine?.setPitchLock(el.lock.checked));

// ---------- Contexto Web Audio (desbloqueo en iOS) ----------
const wantKey = () => `${el.latency.value}|${el.lookAhead.value}`;
function paintUnlock() {
  const needs = !unlocked || ctxKey !== wantKey();
  el.unlock.hidden = !needs;
  el.unlock.textContent = unlocked ? 'Aplicar contexto nuevo' : 'Activar audio';
}
// Todo lo que toca el AudioContext pasa aquí, de forma síncrona dentro del toque (requisito de iOS)
el.unlock.addEventListener('click', () => {
  const keep = engine ? { pos: engine.position(), playing: engine.playing } : null;
  if (ctxKey !== wantKey()) {
    if (engine && engine.id !== 'audio') { engine.dispose(); engine = null; } // sus nodos son del contexto viejo
    // Contexto nativo (no el envoltorio de Tone) para que el AudioWorklet de Signalsmith también lo pueda usar
    const raw = new AudioContext({ latencyHint: el.latency.value as AudioContextLatencyCategory });
    const c = new Tone.Context(raw as any);
    c.lookAhead = +el.lookAhead.value;
    Tone.setContext(c, true);
    ctxKey = wantKey();
  }
  const session = (navigator as any).audioSession;
  if (session) session.type = 'playback'; // Safari 16.4+: que el interruptor de silencio no lo calle
  Tone.start();
  unlocked = true;
  paintUnlock();
  if (!engine) build(keep);
});
el.latency.addEventListener('change', paintUnlock);
el.lookAhead.addEventListener('change', paintUnlock);

$<HTMLSelectElement>('stretchPreset').addEventListener('change', (e) => engine?.tune?.('cheaper', (e.target as HTMLSelectElement).value === 'cheaper' ? 1 : 0));

for (const [id, key, out, unit] of [['grainSize', 'grainSize', 'gsOut', 's'], ['overlap', 'overlap', 'ovOut', 's'], ['windowSize', 'windowSize', 'wsOut', 's']] as const) {
  const input = el[id];
  const show = () => ($(out).textContent = `${(+input.value).toFixed(3)} ${unit}`);
  input.addEventListener('input', () => { show(); engine?.tune?.(key, +input.value); });
  show();
}

// ---------- Canción ----------
/**
 * Segundos aproximados sin cargar metadatos (iOS no los da hasta un toque).
 * MP3: tamaño / bitrate del primer frame. WAV: cabecera. Otros: se asume ~128 kbps (estimación alta).
 */
async function estimateSeconds(blob: Blob) {
  const u = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57) { // RIFF…WAVE
    const v = new DataView(u.buffer);
    return { sec: blob.size / (v.getUint32(28, true) || 176400), mp3: false };
  }
  let i = 0;
  if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) i = 10 + ((u[6] << 21) | (u[7] << 14) | (u[8] << 7) | u[9]); // saltar ID3
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  for (; i < u.length - 4; i++) {
    if (u[i] !== 0xff || (u[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (u[i + 1] >> 3) & 3, layer = (u[i + 1] >> 1) & 3, bri = (u[i + 2] >> 4) & 15;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15) continue;
    return { sec: (blob.size * 8) / ((ver === 3 ? BR1 : BR2)[bri] * 1000), mp3: true };
  }
  return { sec: (blob.size * 8) / 128000, mp3: false };
}

/** Aviso visible bajo el selector de motor (en amarillo si es un problema) */
const note = (msg: string, warn = false) => {
  const n = $('engNote');
  n.textContent = msg;
  n.classList.toggle('text-warn', warn);
  n.classList.toggle('text-muted', !warn);
};
/** Si la canción no cabe en RAM, los motores Web Audio prueban con este tramo del inicio */
const SEGMENT_SEC = 8 * 60;
let segmentMsg = '';

async function decoded(blob: Blob) {
  if (cache?.blob === blob) return cache.buf;
  cache = null; // se suelta el anterior antes de decodificar el siguiente (no dos en memoria)
  const { sec, mp3 } = await estimateSeconds(blob);
  const est = sec * Tone.getContext().sampleRate * 2 * 4;
  let bytes: Blob = blob;
  segmentMsg = '';
  if (est > RAM_LIMIT) {
    const mb = (est / 1e6).toFixed(0), min = (sec / 60).toFixed(0);
    if (!mp3) { note(`Dura ~${min} min: completa ocuparía ~${mb} MB de RAM. Este formato no se puede recortar; usa <audio> o un MP3.`, true); return null; }
    // MP3: se corta por bytes (el decodificador se sincroniza solo con el siguiente frame)
    bytes = blob.slice(0, Math.floor(blob.size * (SEGMENT_SEC / sec)));
    segmentMsg = `Mix de ~${min} min (completo serían ~${mb} MB de RAM): se prueba con los primeros ${SEGMENT_SEC / 60} min.`;
  }
  const t0 = performance.now();
  const buf = await Promise.race([
    Tone.getContext().decodeAudioData(await bytes.arrayBuffer()),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('el navegador no terminó de decodificar en 30 s')), 30000)),
  ]);
  decodeMs = performance.now() - t0;
  cache = { blob, buf };
  return buf;
}

async function build(keep: { pos: number; playing: boolean } | null = null) {
  const token = ++buildToken;
  keep ??= engine ? { pos: engine.position(), playing: engine.playing } : { pos: 0, playing: false };
  engine?.dispose();
  engine = null;
  el.pp.disabled = true;
  note(NOTES[engineId]);
  $('grainTune').hidden = engineId !== 'grain';
  $('psTune').hidden = engineId !== 'player-ps';
  $('stretchTune').hidden = engineId !== 'stretch';
  if (!src) return;
  if (engineId !== 'audio' && !unlocked) { note('Toca "Activar audio" (en Contexto Web Audio, aquí abajo) para usar este motor.', true); return; }
  let e: Engine | null = null;
  let idx: Awaited<ReturnType<typeof indexMp3>> | undefined;
  try {
    if (engineId === 'audio') {
      const ae = new AudioEngine(src.blob); // no se esperan metadatos: en iOS llegan recién con el primer play
      ae.onError = (m) => note(m, true);
      e = ae;
    } else if (engineId === 'stretch' && (idx ??= (note('Indexando MP3…'), await indexMp3(src.blob)))) {
      // MP3 → por tramos: cualquier duración con poca RAM
      const raw = Tone.getContext().rawContext as AudioContext;
      e = await StreamStretchEngine.create(raw, src.blob, idx, (s) => note(s || NOTES.stretch));
      note(NOTES.stretch);
    } else {
      note('Decodificando…');
      const buf = await decoded(src.blob);
      if (!buf) return;
      if (segmentMsg) toast(`Probando con los primeros ${SEGMENT_SEC / 60} min del mix`);
      e = engineId === 'stretch'
        ? await StretchEngine.create(Tone.getContext().rawContext as AudioContext, buf)
        : engineId === 'grain'
          ? new GrainEngine(buf, +el.grainSize.value, +el.overlap.value)
          : new PlayerEngine(buf, engineId === 'player-ps', +el.windowSize.value);
      note(segmentMsg ? `${segmentMsg} ${NOTES[engineId]}` : NOTES[engineId], !!segmentMsg);
    }
  } catch (err: any) { note(`No se pudo cargar con este motor: ${err?.message || err}`, true); return; }
  if (token !== buildToken) { e.dispose(); return; } // llegó otro cambio mientras cargaba
  engine = e;
  e.setPitchLock(el.lock.checked);
  e.setRate(rate(applied));
  if (keep.pos && e.duration) e.seek(Math.min(keep.pos, e.duration - 0.25));
  if (keep.playing) e.play();
  el.pp.disabled = false;
}

function useSource(key: string) {
  src = sources.get(key) ?? null;
  $('title').textContent = src?.title ?? 'Sin canción';
  $('baseBpm').textContent = src?.bpm ? `${src.bpm} bpm` : 'BPM desconocido (base 128)';
  build({ pos: 0, playing: false });
  paintBpm();
}
el.src.addEventListener('change', () => useSource(el.src.value));
el.file.addEventListener('change', () => {
  const f = el.file.files?.[0];
  el.file.value = '';
  if (!f) return;
  sources.set('file', { blob: f, title: f.name, bpm: null });
  let opt = el.src.querySelector<HTMLOptionElement>('option[value="file"]');
  if (!opt) { opt = new Option('', 'file'); el.src.add(opt); }
  opt.textContent = `Archivo · ${f.name}`;
  el.src.value = 'file';
  useSource('file');
});

document.querySelectorAll<HTMLInputElement>('input[name="eng"]').forEach((r) =>
  r.addEventListener('change', () => { engineId = r.value as EngineId; build(); }),
);

// ---------- Transporte ----------
el.pp.addEventListener('click', () => {
  if (!engine) return;
  if (engine.id !== 'audio') Tone.start(); // por si iOS suspendió el contexto
  engine.playing ? engine.pause() : engine.play();
});
const seekTo = (t: number) => { if (engine) engine.seek(Math.min(engine.duration - 0.25, Math.max(0, t))); };
document.querySelectorAll<HTMLButtonElement>('[data-skip]').forEach((b) =>
  b.addEventListener('click', () => engine && seekTo(engine.position() + +b.dataset.skip!)),
);
let scrubbing = false, scrubP = 0;
const at = (e: PointerEvent) => { const r = el.prog.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
el.prog.addEventListener('pointerdown', (e) => { if (!engine) return; scrubbing = true; el.prog.setPointerCapture(e.pointerId); scrubP = at(e); });
el.prog.addEventListener('pointermove', (e) => { if (scrubbing) scrubP = at(e); });
el.prog.addEventListener('pointerup', (e) => { if (!scrubbing) return; scrubbing = false; if (engine) seekTo(at(e) * engine.duration); });
el.prog.addEventListener('pointercancel', () => (scrubbing = false));

// ---------- Pintado y métricas (un solo bucle rAF) ----------
let lastFrame = 0, janks = 0, worstGap = 0, lastStats = 0;
$('resetStats').addEventListener('click', () => { janks = 0; worstGap = 0; });
function frame(now: number) {
  // Saltos del hilo principal > 50 ms: con GrainPlayer son la causa típica de cortes
  if (lastFrame && !document.hidden) {
    const gap = now - lastFrame;
    if (gap > 50) { janks++; worstGap = Math.max(worstGap, gap); }
  }
  lastFrame = now;
  const dur = engine?.duration || 0;
  const t = scrubbing ? scrubP * dur : engine?.position() ?? 0;
  el.prog.style.setProperty('--p', dur ? `${(t / dur) * 100}%` : '0%');
  $('cur').textContent = fmt(t);
  $('rem').textContent = `-${fmt(dur - t)}`;
  const label = engine?.playing ? 'Pausa' : 'Play';
  if (el.pp.textContent !== label) el.pp.textContent = label;
  if (now - lastStats > 300) { lastStats = now; paintStats(); }
  requestAnimationFrame(frame);
}
function paintStats() {
  const rows: Record<string, string> = { Motor: engineId };
  if (unlocked) {
    const c = Tone.getContext(), raw = c.rawContext as AudioContext;
    rows['Contexto'] = `${c.state} · ${c.sampleRate} Hz`;
    rows['Latencia salida'] = `${((raw.baseLatency || 0) * 1000).toFixed(0)} + ${((raw.outputLatency || 0) * 1000).toFixed(0)} ms`;
    rows['lookAhead'] = `${(c.lookAhead * 1000).toFixed(0)} ms`;
  }
  if (cache && engineId !== 'audio') rows['Decodificar'] = `${decodeMs.toFixed(0)} ms · ${(bufferBytes(cache.buf) / 1e6).toFixed(0)} MB`;
  Object.assign(rows, engine?.stats() ?? {});
  rows['Saltos hilo >50 ms'] = `${janks}${worstGap ? ` (peor ${worstGap.toFixed(0)} ms)` : ''}`;
  el.stats.innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------- Inicio ----------
document.addEventListener('visibilitychange', () => { lastFrame = 0; });
window.addEventListener('pagehide', () => { engine?.dispose(); engine = null; cache = null; });
el.fader.value = String(applied);
paintBpm();
paintUnlock();
requestAnimationFrame(frame);
dbAll().then((rows) => {
  el.src.innerHTML = '';
  for (const r of rows.filter((x) => x.id === 'a' || x.id === 'b').sort((x, y) => x.id.localeCompare(y.id))) {
    sources.set(r.id, { blob: r.blob, title: r.title, bpm: r.bpm });
    el.src.add(new Option(`Deck ${r.id.toUpperCase()} · ${r.title}`, r.id));
  }
  if (!sources.size) el.src.add(new Option('No hay canciones en los decks: elige un archivo', ''));
  else useSource(el.src.value);
}).catch(() => { el.src.innerHTML = '<option value="">Elige un archivo</option>'; });
