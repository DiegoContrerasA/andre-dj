// Utilidades de DOM y almacenamiento local
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const vibrate = (ms: number) => navigator.vibrate?.(ms);

let toastTimer: number | undefined;
export const toast = (msg: string) => {
  const t = $('toast');
  t.textContent = msg;
  t.dataset.show = '';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => delete t.dataset.show, 2200);
};

/** Segundos → "m:ss" */
export const fmt = (t: number) =>
  isFinite(t) && t >= 0 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00';

/** localStorage con JSON y sin lanzar errores (modo privado, etc.) */
export const ls = {
  get: <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k)!) ?? d; } catch { return d; } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k: string) => { try { localStorage.removeItem(k); } catch {} },
};
