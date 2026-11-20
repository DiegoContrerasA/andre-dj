// Ajustes: mantener tono, pantalla encendida, terminar sesión y bienvenida
import { $, ls, toast } from '../lib/dom';
import { dbClear } from '../lib/db';
import { allDecks, decks, state } from './player';
import { applyTempo } from './tempo-ui';
import { setSong } from './decks';
import { openSheet, closeSheet } from './sheets';

function setupPitchLock() {
  const lock = $<HTMLInputElement>('lock');
  const apply = () => {
    state.pitchLock = lock.checked;
    allDecks().forEach((d) => d.engine?.setPitchLock(lock.checked));
  };
  lock.onchange = apply;
  apply();
}

function setupWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const wake = $<HTMLInputElement>('wake');
  let wakeLock: WakeLockSentinel | null = null;
  $('wakeRow').hidden = false;
  wake.checked = ls.get('wake', false);
  const request = async () => {
    if (!wake.checked || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  };
  wake.onchange = async () => {
    ls.set('wake', wake.checked);
    if (wake.checked) request();
    else { await wakeLock?.release(); wakeLock = null; }
  };
  document.addEventListener('visibilitychange', request);
  request();
}

function setupEndSession() {
  // La confirmación muestra qué se va a borrar de cada deck
  const fill = () => allDecks().forEach((d) => {
    const row = document.querySelector<HTMLElement>(`[data-end-deck="${d.id}"]`)!;
    row.querySelector('[data-end-title]')!.textContent = d.song?.title ?? 'Sin canción';
    row.querySelector('[data-end-sub]')!.textContent = d.song ? d.song.artist || 'Sin artista' : `Deck ${d.id.toUpperCase()} vacío`;
    row.classList.toggle('opacity-50', !d.song);
  });
  $('end').onclick = () => { fill(); closeSheet('settings'); setTimeout(() => openSheet('modal'), 180); };
  $('cancelEnd').onclick = () => closeSheet('modal');
  $('confirmEnd').onclick = async () => {
    await dbClear();
    setSong(decks.a, null);
    setSong(decks.b, null);
    state.shared = null;
    ls.del('sharedBpm');
    applyTempo();
    closeSheet('modal');
    toast('Sesión terminada. Todo borrado.');
  };
}

function setupWelcome() {
  const welcome = $('welcome');
  if (!ls.get('welcomed', false)) welcome.hidden = false;
  $('startApp').onclick = () => { welcome.hidden = true; ls.set('welcomed', true); };
  $('openGuide').onclick = () => { closeSheet('settings'); welcome.hidden = false; };
}

export function setupSettings() {
  $('openSettings').onclick = () => openSheet('settings');
  setupPitchLock();
  setupWakeLock();
  setupEndSession();
  setupWelcome();
}
