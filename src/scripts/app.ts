// Punto de entrada: conecta todas las piezas de la app
import { setupDecks, restoreSession } from './decks';
import { setupMasterControls } from './tempo-ui';
import { setupMediaSession } from './media-session';
import { setupSheets } from './sheets';
import { setupSettings } from './settings';
import { setupPwa } from './pwa';

setupDecks();
setupMasterControls();
setupMediaSession();
setupSheets();
setupSettings();
setupPwa();
restoreSession();
