// Punto de entrada: conecta todas las piezas de la app
import { setupDecks, restoreSession } from './decks';
import { setupMasterControls } from './tempo-ui';
import { setupMediaSession } from './media-session';
import { setupSheets } from './sheets';
import { setupSettings } from './settings';
import { setupPwa } from './pwa';
import { unlockAudio } from '../lib/audio/context';

setupDecks();
setupMasterControls();
setupMediaSession();
setupSheets();
setupSettings();
setupPwa();
restoreSession();

// iOS solo deja arrancar (o reanudar tras una llamada o el bloqueo) el audio dentro de un toque:
// cualquier toque en la app lo desbloquea, no solo el botón de play
for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
