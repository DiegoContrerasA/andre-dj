// Cada deck: cargar archivo, play/pausa, progreso, saltos de 10 s y detección de BPM
import { fmt, toast, vibrate } from '../lib/dom';
import { dbAll, dbDel, dbPut } from '../lib/db';
import { parseName, tidy } from '../lib/filename';
import { detectBpm } from '../lib/audio/bpm-detect';
import { inRange, round1 } from '../lib/tempo';
import { svg } from '../lib/icons';
import { allDecks, analyzing, decks, playingDeck, rateOf, state, toggle, type Deck } from './player';
import { applyTempo, paintDeck } from './tempo-ui';
import { syncMediaSession } from './media-session';
import type { DeckId, Song } from '../lib/types';

const PLAY_ICON = svg('play', 2);
const PAUSE_ICON = svg('pause', 2);
const label = (d: Deck) => `Deck ${d.id.toUpperCase()}`;

export function setSong(d: Deck, song: Song | null) {
  d.audio.pause();
  if (d.url) { URL.revokeObjectURL(d.url); d.url = null; }
  d.song = song;
  if (song) { d.url = URL.createObjectURL(song.blob); d.audio.src = d.url; }
  else { d.audio.removeAttribute('src'); d.audio.load(); }
  d.f('cur').textContent = '0:00';
  d.f('rem').textContent = '-0:00';
  d.f('prog').style.setProperty('--p', '0%');
  applyTempo();
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
  const { audio } = d;
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

  // Estado visual
  const sync = () => {
    d.el.classList.toggle('playing', !audio.paused);
    d.f('pp').innerHTML = audio.paused ? PLAY_ICON : PAUSE_ICON;
  };
  const live = () => document.body.classList.toggle('live', !!playingDeck());
  audio.addEventListener('play', () => { state.lastActive = d; sync(); live(); syncMediaSession(); });
  audio.addEventListener('pause', () => { sync(); live(); syncMediaSession(); });
  audio.addEventListener('ended', sync);
  audio.addEventListener('loadedmetadata', () => { audio.playbackRate = rateOf(d); tick(); });

  // Tiempo y barra de progreso
  const prog = d.f('prog');
  let scrubbing = false;
  const tick = () => {
    const dur = audio.duration;
    d.f('cur').textContent = fmt(audio.currentTime);
    d.f('rem').textContent = `-${fmt((dur || 0) - audio.currentTime)}`;
    if (!scrubbing) prog.style.setProperty('--p', dur ? `${(audio.currentTime / dur) * 100}%` : '0%');
  };
  audio.addEventListener('timeupdate', tick);

  // Tocar o arrastrar la barra para moverse
  const at = (e: PointerEvent) => { const r = prog.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  prog.addEventListener('pointerdown', (e) => {
    if (!audio.duration) return;
    scrubbing = true;
    prog.setPointerCapture(e.pointerId);
    prog.style.setProperty('--p', `${at(e) * 100}%`);
  });
  prog.addEventListener('pointermove', (e) => { if (scrubbing) prog.style.setProperty('--p', `${at(e) * 100}%`); });
  prog.addEventListener('pointerup', (e) => { if (!scrubbing) return; scrubbing = false; audio.currentTime = at(e) * audio.duration; });
  prog.addEventListener('pointercancel', () => { scrubbing = false; tick(); });

  // Adelantar / retroceder 10 s: botones y doble toque a la izquierda/derecha de la tarjeta
  const fx = d.f('fx');
  let fxTimer: number | undefined, fxSum = 0, fxDir = 0;
  const skip = (secs: number) => {
    if (!d.song || !audio.duration) return;
    audio.currentTime = Math.min(audio.duration - 0.25, Math.max(0, audio.currentTime + secs));
    tick();
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
