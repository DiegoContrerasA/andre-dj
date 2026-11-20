// Controles del sistema (pantalla bloqueada, auriculares, notificación)
import { state, decks, other, playingDeck, currentDeck, toggle } from './player';

export function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const d = currentDeck();
  ms.playbackState = playingDeck() ? 'playing' : 'paused';
  if (!d?.song) return;
  ms.metadata = new MediaMetadata({
    title: d.song.title,
    artist: `Deck ${d.id.toUpperCase()}${state.shared ? ` · ${state.shared.toFixed(1)} BPM` : ''}`,
    album: "Andre's DJ",
    artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  if (d.audio.duration && isFinite(d.audio.duration)) {
    try {
      ms.setPositionState({ duration: d.audio.duration, position: Math.min(d.audio.currentTime, d.audio.duration), playbackRate: d.audio.playbackRate || 1 });
    } catch {}
  }
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
    ['seekbackward', (e) => { const d = cur(); if (d) d.audio.currentTime -= e.seekOffset ?? 10; }],
    ['seekforward', (e) => { const d = cur(); if (d) d.audio.currentTime += e.seekOffset ?? 10; }],
    ['seekto', (e) => { const d = cur(); if (d && e.seekTime != null) d.audio.currentTime = e.seekTime; }],
  ];
  for (const [a, h] of handlers) { try { navigator.mediaSession.setActionHandler(a, h); } catch {} }
}
