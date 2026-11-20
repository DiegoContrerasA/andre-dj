// Hojas inferiores con sensación nativa: se arrastran con el dedo y se cierran por distancia o velocidad
import { $, vibrate } from '../lib/dom';

const resetDrag = (m: HTMLElement) => {
  m.style.removeProperty('--drag');
  m.style.removeProperty('--fade');
  document.body.style.removeProperty('--fade');
};

export function openSheet(id: string) {
  const m = $(id);
  resetDrag(m);
  m.classList.add('show');
  document.body.classList.add('sheet-open');
  vibrate(6);
}

export function closeSheet(id: string) {
  const m = $(id);
  resetDrag(m);
  m.classList.remove('show');
  if (!document.querySelector('.modal.show')) document.body.classList.remove('sheet-open');
}

function setupDrag(m: HTMLElement) {
  const sheet = m.querySelector<HTMLElement>('.sheet')!;
  m.addEventListener('click', (e) => { if (e.target === m) closeSheet(m.id); }); // tocar afuera

  let startY = 0, lastY = 0, lastT = 0, vel = 0, dragging = false, pending = false, h = 1;
  const set = (dy: number) => {
    const y = dy < 0 ? -Math.pow(-dy, 0.6) : dy; // hacia arriba cede poco (elástico)
    m.style.setProperty('--drag', `${y}px`);
    const fade = String(Math.max(0, 1 - Math.max(0, dy) / h));
    m.style.setProperty('--fade', fade);
    document.body.style.setProperty('--fade', fade);
  };

  // Si el contenido no cabe (pantallas muy bajitas), se permite scroll y se arrastra desde la cabecera
  const fit = () => { sheet.style.touchAction = sheet.scrollHeight > sheet.clientHeight + 1 ? 'pan-y' : 'none'; };
  new MutationObserver(fit).observe(m, { attributes: true, attributeFilter: ['class'] });

  sheet.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || sheet.scrollTop > 0) return; // si el contenido está desplazado, primero se hace scroll normal
    startY = lastY = e.clientY; lastT = e.timeStamp; vel = 0; pending = true; h = sheet.offsetHeight;
  });
  sheet.addEventListener('pointermove', (e) => {
    if (!pending && !dragging) return;
    const dy = e.clientY - startY;
    if (pending) {
      if (Math.abs(dy) < 6) return; // umbral: un toque no es arrastre
      pending = false; dragging = true;
      sheet.setPointerCapture(e.pointerId);
      m.classList.add('dragging'); document.body.classList.add('sheet-dragging');
    }
    const dt = Math.max(1, e.timeStamp - lastT);
    vel = 0.8 * ((e.clientY - lastY) / dt) + 0.2 * vel; // px/ms suavizado
    lastY = e.clientY; lastT = e.timeStamp;
    set(dy);
  });
  const end = (e: PointerEvent) => {
    pending = false;
    if (!dragging) return;
    dragging = false;
    m.classList.remove('dragging'); document.body.classList.remove('sheet-dragging');
    if (e.clientY - startY > h * 0.25 || vel > 0.45) { vibrate(4); closeSheet(m.id); }
    else resetDrag(m);
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

export function setupSheets() {
  document.querySelectorAll<HTMLElement>('.modal').forEach(setupDrag);
  document.querySelectorAll<HTMLElement>('.modal').forEach((m) =>
    m.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-close]')) closeSheet(m.id); }),
  );
}
