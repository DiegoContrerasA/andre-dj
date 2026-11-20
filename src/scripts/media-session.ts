// Controles del sistema (pantalla bloqueada, auriculares, notificación)
import { state, decks, other, playingDeck, currentDeck, toggle, seek, position } from './player';

let lastMeta = '';

export function syncMediaSession() {
  clearTimeout(soonTimer);
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const d = currentDeck();
  ms.playbackState = playingDeck() ? 'playing' : 'paused';
  if (!d?.song) return;
  const artist = `Deck ${d.id.toUpperCase()}${state.shared ? ` · ${state.shared.toFixed(1)} BPM` : ''}`;
  // Solo se recrea la ficha (con su imagen) si cambió el texto
  const key = `${d.song.title}\n${artist}`;
  if (key !== lastMeta || !ms.metadata) {
    lastMeta = key;
    ms.metadata = new MediaMetadata({
      title: d.song.title,
      artist,
      album: "Andre's DJ",
      artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  const dur = d.audio.duration;
  if (dur && isFinite(dur)) {
    try {
      ms.setPositionState({ duration: dur, position: Math.min(position(d), dur), playbackRate: d.audio.playbackRate || 1 });
    } catch {}
  }
}

/** Para cambios en ráfaga (fader, seeks): actualiza la pantalla bloqueada una vez que se calman */
let soonTimer: number | undefined;
export function syncMediaSessionSoon() {
  clearTimeout(soonTimer);
  soonTimer = window.setTimeout(syncMediaSession, 300);
}

export function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const cur = () => currentDeck() ?? (decks.a.song ? decks.a : decks.b);
  const switchDeck = () => { const d = cur(); if (d && other(d).song) toggle(other(d)); }; // siguiente/anterior = el otro deck
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => { const d = cur(); if (d?.audio.paused) toggle(d); }],
    ['pause', () => playingDeck()?.audio.pause()],
    ['nexttrack', switchDeck],
    ['previoustrack', switchDeck],
    ['seekbackward', (e) => { const d = cur(); if (d) seek(d, position(d) - (e.seekOffset ?? 10)); }],
    ['seekforward', (e) => { const d = cur(); if (d) seek(d, position(d) + (e.seekOffset ?? 10)); }],
    ['seekto', (e) => { const d = cur(); if (d && e.seekTime != null) seek(d, e.seekTime); }],
  ];
  for (const [a, h] of handlers) { try { navigator.mediaSession.setActionHandler(a, h); } catch {} }
}
