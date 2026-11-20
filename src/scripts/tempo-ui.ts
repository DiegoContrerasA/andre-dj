// BPM maestro: aplica la velocidad a los decks y pinta fader, marcas A/B y botones de volver
import { $, ls, toast, vibrate } from '../lib/dom';
import { baseBpm, clampBpm, inRange, posPct, round1 } from '../lib/tempo';
import { allDecks, analyzing, currentDeck, decks, rateOf, setRate, state, type Deck } from './player';
import { syncMediaSessionSoon } from './media-session';
import type { DeckId } from '../lib/types';

const fader = $<HTMLInputElement>('fader');

/** BPM base del deck redondeado y dentro del rango del fader */
const deckTarget = (d: Deck) => (d.song?.bpm ? round1(clampBpm(baseBpm(d.song.bpm))) : null);

export function paintDeck(d: Deck) {
  const s = d.song;
  d.el.classList.toggle('empty', !s);
  d.f('title').textContent = s ? s.title : 'Sin canción';
  d.f('artist').textContent = s ? s.artist || 'Sin artista' : 'Carga un archivo';
  d.f('bpmtag').innerHTML = s?.bpm ? `<b>${s.bpm}</b> bpm` : '— bpm';
  d.el.querySelector<HTMLButtonElement>('[data-act="toggle"]')!.disabled = !s;

  const sh = d.f('shift');
  const label = sh.querySelector('span')!;
  delete sh.dataset.level;
  sh.title = '';
  if (!s) { label.textContent = '—'; return; }
  if (!s.bpm) { label.textContent = analyzing.has(s) ? 'Detectando BPM…' : 'BPM no detectado'; return; }

  const base = baseBpm(s.bpm);
  const pct = (rateOf(d) - 1) * 100;
  const a = Math.abs(pct);
  sh.dataset.level = a <= 8 ? 'ok' : a <= 16 ? 'mid' : 'bad';
  sh.title = a <= 8 ? 'Natural' : a <= 16 ? 'Se nota un poco' : 'Puede sonar distorsionado';
  const octave = base !== s.bpm ? (base > s.bpm ? ' ·×2' : ' ·÷2') : '';
  label.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%${octave}`;
}

function paintGuide() {
  const pos: Partial<Record<DeckId, number>> = {};
  for (const d of allDecks()) {
    const mark = document.querySelector<HTMLElement>(`[data-mark="${d.id}"]`)!;
    const btn = document.querySelector<HTMLButtonElement>(`[data-reset="${d.id}"]`)!;
    const raw = d.song?.bpm ? baseBpm(d.song.bpm) : null;
    const base = deckTarget(d);
    const reachable = !!raw && inRange(raw);
    mark.hidden = !base;
    btn.disabled = !base;
    btn.querySelector('b')!.textContent = base ? `${reachable ? '' : '≈'}${base.toFixed(1)}` : '—';
    btn.title = base && !reachable ? `El original (${raw!.toFixed(1)}) está fuera de 107–180; este es el punto más cercano` : '';
    btn.classList.toggle('on', !!base && state.shared === base);
    if (base) { mark.style.left = `${posPct(base)}%`; pos[d.id] = posPct(base); }
  }
  // Si las dos marcas quedan muy juntas, la B sube para que no se tapen
  const near = pos.a != null && pos.b != null && Math.abs(pos.a - pos.b) < 7;
  document.querySelector('[data-mark="b"]')!.classList.toggle('near', near);
}

let saveTimer: number | undefined;
const spinOf = new WeakMap<Deck, string>();

export function applyTempo() {
  const withBpm = allDecks().find((d) => d.song?.bpm);
  if (state.shared == null) state.shared = withBpm ? baseBpm(withBpm.song!.bpm!) : 128;
  const shared = (state.shared = round1(clampBpm(state.shared)));
  fader.disabled = false;
  fader.value = String(shared);
  // Guardar en localStorage es síncrono: se espera a que el fader se detenga
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => ls.set('sharedBpm', state.shared), 400);
  $('bpmOut').textContent = shared.toFixed(1);
  paintGuide();
  for (const d of allDecks()) {
    const r = rateOf(d);
    setRate(d, r);
    const spin = `${(1.8 / r).toFixed(2)}s`;
    if (spinOf.get(d) !== spin) { spinOf.set(d, spin); d.el.style.setProperty('--spin', spin); }
    paintDeck(d);
  }
  syncMediaSessionSoon(); // la pantalla bloqueada se actualiza al soltar, no en cada paso del fader
}

export const setShared = (bpm: number) => { state.shared = bpm; applyTempo(); };

/** Vuelve al BPM original del deck */
const resetTo = (d: Deck | null, msg?: string) => {
  if (!d?.song?.bpm) return;
  setShared(baseBpm(d.song.bpm));
  vibrate(15);
  if (msg) toast(msg);
};

/** Imán: al arrastrar cerca (±0.8 BPM) del original de un deck, se pega a él */
const snap = (bpm: number) => {
  for (const d of allDecks()) {
    const base = deckTarget(d);
    if (base != null && Math.abs(bpm - base) <= 0.8) {
      if (state.shared !== base) vibrate(10);
      return base;
    }
  }
  return bpm;
};

export function setupMasterControls() {
  // Un cambio de velocidad por cuadro como máximo, aunque el navegador mande más eventos input
  let raf = 0;
  fader.addEventListener('input', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; setShared(snap(+fader.value)); });
  });

  // Botones − / +: un toque mueve 0.5; mantener presionado repite
  const nudge = (dir: number) => setShared((state.shared ?? 128) + dir * 0.5);
  for (const [id, dir] of [['plus', 1], ['minus', -1]] as const) {
    const b = $(id);
    let timer: number | undefined, rep: number | undefined;
    const end = () => { clearTimeout(timer); clearInterval(rep); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); nudge(dir); vibrate(8);
      timer = window.setTimeout(() => (rep = window.setInterval(() => nudge(dir), 80)), 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, end));
  }

  document.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach((b) =>
    b.addEventListener('click', () => resetTo(decks[b.dataset.reset as DeckId])),
  );

  // Doble toque en el número: vuelve al BPM original del deck que suena (o el último usado)
  let lastTap = 0;
  $('bigBpm').addEventListener('click', () => {
    const now = Date.now();
    const d = currentDeck();
    if (now - lastTap < 350 && d) resetTo(d, `BPM original del deck ${d.id.toUpperCase()}`);
    lastTap = now;
  });
}
