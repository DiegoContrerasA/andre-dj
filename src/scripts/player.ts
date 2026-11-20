// Estado de la sesión: los dos decks, el BPM compartido y la reproducción
import { $, ls } from '../lib/dom';
import { baseBpm } from '../lib/tempo';
import { unlockAudio } from '../lib/audio/context';
import type { DeckEngine } from '../lib/audio/engines';
import type { DeckId, Song } from '../lib/types';

export type Deck = {
  id: DeckId;
  el: HTMLElement;
  /** <audio> del deck: solo lo usa el motor de respaldo (formatos que no son MP3) */
  audio: HTMLAudioElement;
  song: Song | null;
  /** null mientras se analiza el archivo para elegir motor */
  engine: DeckEngine | null;
  /** Se tocó play antes de que el motor estuviera listo */
  pendingPlay: boolean;
  /** Elemento del deck con data-f="name" */
  f: <T extends HTMLElement = HTMLElement>(name: string) => T;
};

const mkDeck = (id: DeckId): Deck => {
  const el = $(`deck-${id}`);
  return { id, el, audio: el.querySelector('audio')!, song: null, engine: null, pendingPlay: false, f: (n) => el.querySelector(`[data-f="${n}"]`)! };
};

export const decks: Record<DeckId, Deck> = { a: mkDeck('a'), b: mkDeck('b') };
export const allDecks = () => Object.values(decks);

export const state = {
  shared: ls.get<number | null>('sharedBpm', null),
  lastActive: null as Deck | null,
  pitchLock: true,
};

/** Canciones a las que se les está detectando el BPM */
export const analyzing = new WeakSet<Song>();

/** Repinta un deck (lo registra decks.ts) */
export const ui = new Map<DeckId, () => void>();
export const refresh = (d: Deck) => ui.get(d.id)?.();

export const other = (d: Deck) => (d.id === 'a' ? decks.b : decks.a);
export const isPlaying = (d: Deck) => !!d.engine?.playing || d.pendingPlay;
export const playingDeck = () => allDecks().find(isPlaying) ?? null;
/** Deck que suena o, si no, el último que sonó */
export const currentDeck = () => playingDeck() ?? state.lastActive;

export const duration = (d: Deck) => d.engine?.duration ?? 0;
export const position = (d: Deck) => d.engine?.position() ?? 0;

export function rateOf(d: Deck) {
  if (!d.song?.bpm || !state.shared) return 1;
  return state.shared / baseBpm(d.song.bpm);
}

export const setRate = (d: Deck, r: number) => d.engine?.setRate(r);

/** Seek sin pausar (cada motor se encarga de no encadenar seeks) */
export function seek(d: Deck, t: number) {
  const dur = duration(d);
  if (!d.song || !d.engine || !dur) return;
  d.engine.seek(Math.min(dur - 0.25, Math.max(0, t)));
}

export function pause(d: Deck) {
  const was = d.pendingPlay;
  d.pendingPlay = false;
  if (d.engine) d.engine.pause();
  else if (was) refresh(d);
}

export function toggle(d: Deck) {
  unlockAudio(); // dentro del toque: requisito de iOS para que suene Web Audio
  if (!d.song) return;
  if (isPlaying(d)) { pause(d); return; }
  pause(other(d)); // solo suena un deck a la vez
  state.lastActive = d;
  if (!d.engine) { d.pendingPlay = true; refresh(d); return; } // aún preparando: arranca cuando esté listo
  d.engine.setRate(rateOf(d));
  d.engine.play();
}
