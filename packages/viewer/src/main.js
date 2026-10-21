import { initStage, app } from './app/stage.js';
import { startTicker } from './app/session.js';
import { bindPointer } from './composer/input.js';
import { bindUi } from './ui/bindUi.js';

const stage = document.getElementById('stage');
initStage(stage);
startTicker();
bindUi();
bindPointer(/** @type {HTMLCanvasElement} */ (app.view));
