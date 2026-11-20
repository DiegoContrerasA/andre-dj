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
  /** Destino del último seek pedido mientras no termina (null = no hay seek en curso) */
  seekTarget: number | null;
  /** Llegó otro seek mientras el anterior seguía en curso: se aplica al terminar (evento seeked) */
  seekQueued: boolean;
  seekAt: number;
  /** Elemento del deck con data-f="name" */
  f: <T extends HTMLElement = HTMLElement>(name: string) => T;
};

const mkDeck = (id: DeckId): Deck => {
  const el = $(`deck-${id}`);
  return {
    id, el, audio: el.querySelector('audio')!, song: null, url: null,
    seekTarget: null, seekQueued: false, seekAt: 0,
    f: (n) => el.querySelector(`[data-f="${n}"]`)!,
  };
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

/**
 * Aplica la velocidad solo si cambió. En iOS cada asignación de playbackRate con "mantener tono"
 * reconfigura el estirador de tiempo del sistema; repetir el mismo valor 60 veces por segundo
 * mientras se arrastra el fader es trabajo inútil y una fuente probable de microcortes.
 * defaultPlaybackRate se iguala para que un load() no devuelva el deck a 1×.
 */
export function setRate(d: Deck, r: number) {
  const a = d.audio;
  if (Math.abs(a.playbackRate - r) > 1e-4) a.playbackRate = r;
  if (Math.abs(a.defaultPlaybackRate - r) > 1e-4) a.defaultPlaybackRate = r;
}

/** Posición a mostrar: el destino del seek en curso o, si no hay, la real */
export const position = (d: Deck) => d.seekTarget ?? d.audio.currentTime;

/**
 * Seek sin pausar y con un solo seek en curso a la vez: si llegan varios seguidos (toques de ±10 s,
 * arrastre en la pantalla bloqueada), se guarda el último y se aplica al terminar el actual.
 * Así iOS no vacía y rellena el audio una vez por cada toque.
 */
export function seek(d: Deck, t: number) {
  const a = d.audio;
  const dur = a.duration;
  if (!d.song || !dur || !isFinite(dur)) return;
  t = Math.min(dur - 0.25, Math.max(0, t));
  d.seekTarget = t;
  // Seguridad: si un seek lleva mucho sin terminar, no se espera más
  if (a.seeking && performance.now() - d.seekAt < 1000) { d.seekQueued = true; return; }
  d.seekQueued = false;
  d.seekAt = performance.now();
  a.currentTime = t;
}

/** Llamar en el evento seeked: aplica el seek pendiente o da por terminado el actual */
export function onSeeked(d: Deck) {
  if (d.seekQueued && d.seekTarget != null) {
    d.seekQueued = false;
    d.seekAt = performance.now();
    d.audio.currentTime = d.seekTarget;
    return false;
  }
  d.seekTarget = null;
  return true;
}

export const resetSeek = (d: Deck) => { d.seekTarget = null; d.seekQueued = false; };

export async function toggle(d: Deck) {
  if (!d.song) return;
  if (d.audio.paused) {
    other(d).audio.pause(); // solo suena un deck a la vez
    setRate(d, rateOf(d));
    try { await d.audio.play(); } catch {}
  } else d.audio.pause();
}
