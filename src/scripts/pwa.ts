// App instalable: botón de instalar, instrucciones de iOS, service worker y orientación vertical
import { $, toast } from '../lib/dom';
import { openSheet, closeSheet } from './sheets';

export function setupPwa() {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installEvt: any = null;
  const installEls = [...document.querySelectorAll<HTMLElement>('[data-install]')];
  const showInstall = (on: boolean) => { installEls.forEach((el) => (el.hidden = !on)); $('settingsDot').hidden = !on; };

  if (!standalone) {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; showInstall(true); });
    if (isIos) showInstall(true);
  }
  installEls.forEach((el) => el.addEventListener('click', async () => {
    if (installEvt) {
      installEvt.prompt();
      const r = await installEvt.userChoice;
      installEvt = null;
      if (r?.outcome === 'accepted') showInstall(false);
    } else if (isIos) { closeSheet('settings'); openSheet('iosModal'); }
  }));
  $('iosClose').onclick = () => closeSheet('iosModal');
  window.addEventListener('appinstalled', () => { showInstall(false); toast("Andre's DJ instalada"); });

  if ('serviceWorker' in navigator && location.hostname !== 'localhost') navigator.serviceWorker.register('/sw.js').catch(() => {});

  // Solo vertical (Android instalada; en iOS/navegador se muestra un aviso por CSS)
  const lockPortrait = () => (screen.orientation as any)?.lock?.('portrait').catch(() => {});
  lockPortrait();
  document.addEventListener('fullscreenchange', lockPortrait);
}
