// Cada deck: cargar archivo, play/pausa, progreso, saltos de 10 s y detección de BPM
import { fmt, toast, vibrate } from '../lib/dom';
import { dbAll, dbDel, dbPut } from '../lib/db';
import { parseName, tidy } from '../lib/filename';
import { detectBpm } from '../lib/audio/bpm-detect';
import { inRange, round1 } from '../lib/tempo';
import { svg } from '../lib/icons';
import { indexMp3 } from '../lib/audio/mp3-index';
import { GrainEngine, MediaEngine } from '../lib/audio/engines';
import { allDecks, analyzing, decks, duration, isPlaying, other, playingDeck, position, rateOf, refresh, seek, state, toggle, ui, type Deck } from './player';
import { applyTempo, paintDeck } from './tempo-ui';
import { syncMediaSession, syncMediaSessionSoon } from './media-session';
import type { DeckId, Song } from '../lib/types';

const PLAY_ICON = svg('play', 2);
const PAUSE_ICON = svg('pause', 2);
const label = (d: Deck) => `Deck ${d.id.toUpperCase()}`;

const loadToken = new WeakMap<Deck, number>();

/** Cambia la canción del deck: libera el motor anterior (nodos, ventanas de audio, URL) y prepara uno nuevo */
export function setSong(d: Deck, song: Song | null) {
  const token = (loadToken.get(d) ?? 0) + 1;
  loadToken.set(d, token);
  d.engine?.dispose();
  d.engine = null;
  d.pendingPlay = false;
  d.song = song;
  d.f('cur').textContent = '0:00';
  d.f('rem').textContent = '-0:00';
  d.f('prog').style.setProperty('--p', '0%');
  applyTempo();
  refresh(d);
  if (song) attachEngine(d, song, token);
}

/**
 * MP3 → Tone.GrainPlayer por ventanas (cualquier duración, BPM sin cortes, tono conservado).
 * Otros formatos → <audio> (no se pueden decodificar por tramos).
 */
async function attachEngine(d: Deck, song: Song, token: number) {
  let idx = null;
  try { idx = await indexMp3(song.blob); } catch {}
  if (loadToken.get(d) !== token) return; // se cambió la canción mientras tanto
  const engine = idx ? new GrainEngine(song.blob, idx) : new MediaEngine(d.audio, song.blob);
  engine.onchange = () => refresh(d);
  engine.onerror = (m) => toast(`${label(d)}: ${m}`);
  engine.setPitchLock(state.pitchLock);
  engine.setRate(rateOf(d));
  d.engine = engine;
  if (d.pendingPlay) { d.pendingPlay = false; if (!isPlaying(other(d))) engine.play(); }
  refresh(d);
}

async function autoBpm(d: Deck) {
  const song = d.song;
  if (!song || song.bpm || analyzing.has(song)) return;
  analyzing.add(song);
  paintDeck(d);
  try {
    const raw = await detectBpm(song.blob);
    // La autocorrelación no distingue bien entre mitad/doble: se reporta la octava que cae en 107–180 si existe
    const bpm = raw ? round1([raw, raw * 2, raw / 2].find(inRange) ?? raw) : null;
    if (bpm && !song.bpm) {
      song.bpm = bpm;
      dbPut(song).catch(() => {});
      if (d.song === song) toast(`${label(d)}: ${bpm} BPM detectado`);
    } else if (!raw && d.song === song) toast(`${label(d)}: no se encontró un ritmo claro`);
  } catch (e: any) {
    // El deck suena a velocidad normal; se muestra el motivo para poder diagnosticar
    console.warn('[BPM] detección falló', e);
    if (d.song === song) toast(`${label(d)}: no se pudo detectar el BPM (${e?.name && e.name !== 'Error' ? e.name : e?.message || 'error'})`);
  }
  analyzing.delete(song);
  if (d.song === song) applyTempo();
}

function setupDeck(d: Deck) {
  d.el.querySelectorAll('[data-act="toggle"]').forEach((b) => b.addEventListener('click', () => toggle(d)));

  // Cargar archivo (reemplaza la canción del deck)
  const file = d.f<HTMLInputElement>('file');
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    const song: Song = { id: d.id, name: f.name, blob: f, ...parseName(f.name) };
    setSong(d, song);
    if (!song.bpm) autoBpm(d);
    try { await dbPut(song); navigator.storage?.persist?.(); toast(`${label(d)} cargado`); }
    catch { toast('Suena, pero no se pudo guardar en el celular'); }
  });

  // Estado visual: lo llama el motor cada vez que cambia (play, pausa, carga, fin)
  let wasPlaying = false;
  ui.set(d.id, () => {
    const playing = isPlaying(d);
    d.el.classList.toggle('playing', playing);
    d.el.classList.toggle('loading', !!d.song && (!d.engine || d.engine.loading));
    d.f('pp').innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    document.body.classList.toggle('live', !!playingDeck());
    if (playing && !wasPlaying) { state.lastActive = d; loop(); }
    if (playing !== wasPlaying) syncMediaSession();
    wasPlaying = playing;
    tick();
  });

  // Tiempo y barra de progreso
  const prog = d.f('prog'), cur = d.f('cur'), rem = d.f('rem');
  let scrubbing = false, scrubP = 0, lastCur = '', lastRem = '';
  const paint = (t: number, dur: number) => {
    const c = fmt(t), r = `-${fmt((dur || 0) - t)}`;
    if (c !== lastCur) cur.textContent = lastCur = c; // el texto cambia una vez por segundo
    if (r !== lastRem) rem.textContent = lastRem = r;
  };
  const tick = () => {
    const dur = duration(d);
    if (scrubbing) { paint(scrubP * dur, dur); return; } // mientras se arrastra, se muestra el tiempo bajo el dedo
    const t = position(d);
    paint(t, dur);
    prog.style.setProperty('--p', dur ? `${(t / dur) * 100}%` : '0%');
  };
  // Mientras suena se pinta en cada cuadro (requestAnimationFrame)
  let raf = 0;
  const loop = () => {
    cancelAnimationFrame(raf);
    const step = () => { tick(); if (isPlaying(d)) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  };

  // Tocar o arrastrar la barra para moverse. El seek se hace al soltar, sin pausar.
  const at = (e: PointerEvent) => { const r = prog.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const scrubTo = (p: number) => { scrubP = p; prog.style.setProperty('--p', `${p * 100}%`); tick(); };
  prog.addEventListener('pointerdown', (e) => {
    if (!duration(d)) return;
    scrubbing = true;
    prog.setPointerCapture(e.pointerId);
    scrubTo(at(e));
  });
  prog.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(at(e)); });
  prog.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    seek(d, at(e) * duration(d));
    tick();
    syncMediaSessionSoon();
  });
  prog.addEventListener('pointercancel', () => { scrubbing = false; tick(); });

  // Adelantar / retroceder 10 s: botones y doble toque a la izquierda/derecha de la tarjeta
  const fx = d.f('fx');
  let fxTimer: number | undefined, fxSum = 0, fxDir = 0;
  const skip = (secs: number) => {
    if (!d.song || !duration(d)) return;
    seek(d, position(d) + secs); // desde el destino pendiente: 3 toques rápidos = +30 s exactos
    tick();
    syncMediaSessionSoon();
    fxSum = Math.sign(secs) === fxDir ? fxSum + secs : secs;
    fxDir = Math.sign(secs);
    fx.textContent = `${fxSum > 0 ? '+' : '−'}${Math.abs(fxSum)} s`;
    fx.dataset.side = secs < 0 ? 'l' : 'r';
    fx.classList.add('show');
    clearTimeout(fxTimer);
    fxTimer = window.setTimeout(() => { fx.classList.remove('show'); fxSum = 0; fxDir = 0; }, 650);
    vibrate(6);
  };
  d.el.querySelectorAll<HTMLButtonElement>('[data-skip]').forEach((b) => b.addEventListener('click', () => skip(+b.dataset.skip!)));

  let lastUp = 0, lastX = 0;
  d.el.addEventListener('pointerup', (e) => {
    if ((e.target as HTMLElement).closest('button, input, label, .prog')) return; // no en controles
    const now = e.timeStamp;
    const r = d.el.getBoundingClientRect();
    const side = e.clientX - r.left < r.width / 2 ? -10 : 10;
    if (now - lastUp < 320 && Math.abs(e.clientX - lastX) < 60) { skip(side); lastUp = now - 160; } // toques seguidos acumulan
    else lastUp = now;
    lastX = e.clientX;
  });
}

export const setupDecks = () => allDecks().forEach(setupDeck);

/** Recupera los decks guardados. Migra canciones de la versión anterior (lista) a los decks A y B. */
export async function restoreSession() {
  try {
    let rows = await dbAll();
    const legacy = rows.filter((r) => r.id !== 'a' && r.id !== 'b').sort((x, y) => (x.addedAt ?? 0) - (y.addedAt ?? 0));
    for (const r of legacy) {
      const free = (['a', 'b'] as DeckId[]).find((id) => !rows.some((x) => x.id === id));
      await dbDel(r.id);
      if (free) { const moved = { ...r, id: free }; delete moved.addedAt; await dbPut(moved); rows.push(moved); }
    }
    rows = rows.filter((r) => r.id === 'a' || r.id === 'b');
    for (const r of rows) {
      const d = decks[r.id as DeckId];
      setSong(d, { ...r, title: tidy(r.title), artist: tidy(r.artist) });
      if (!r.bpm) autoBpm(d);
    }
  } catch { toast('En este navegador las canciones no quedan guardadas'); }
  applyTempo();
}
