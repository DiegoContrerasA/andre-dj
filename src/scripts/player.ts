// Estado de la sesión: los dos decks, el BPM compartido y la reproducción
import { $, ls } from '../lib/dom';
import { baseBpm } from '../lib/tempo';
import type { DeckId, Song } from '../lib/types';

export type Deck = {
  id: DeckId;
  el: HTMLElement;
  audio: HTMLAudioElement;
  song: Song | null;
  url: string | null;
  /** Elemento del deck con data-f="name" */
  f: <T extends HTMLElement = HTMLElement>(name: string) => T;
};

const mkDeck = (id: DeckId): Deck => {
  const el = $(`deck-${id}`);
  return { id, el, audio: el.querySelector('audio')!, song: null, url: null, f: (n) => el.querySelector(`[data-f="${n}"]`)! };
};

export const decks: Record<DeckId, Deck> = { a: mkDeck('a'), b: mkDeck('b') };
export const allDecks = () => Object.values(decks);

export const state = {
  shared: ls.get<number | null>('sharedBpm', null),
  lastActive: null as Deck | null,
};

/** Canciones a las que se les está detectando el BPM */
export const analyzing = new WeakSet<Song>();

export const other = (d: Deck) => (d.id === 'a' ? decks.b : decks.a);
export const playingDeck = () => allDecks().find((d) => !d.audio.paused) ?? null;
/** Deck que suena o, si no, el último que sonó */
export const currentDeck = () => playingDeck() ?? state.lastActive;

export function rateOf(d: Deck) {
  if (!d.song?.bpm || !state.shared) return 1;
  return state.shared / baseBpm(d.song.bpm);
}

export async function toggle(d: Deck) {
  if (!d.song) return;
  if (d.audio.paused) {
    other(d).audio.pause(); // solo suena un deck a la vez
    d.audio.playbackRate = rateOf(d);
    try { await d.audio.play(); } catch {}
  } else d.audio.pause();
}
