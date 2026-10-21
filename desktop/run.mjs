/**
 * Start the desktop app from a terminal (pnpm desktop). Clears
 * ELECTRON_RUN_AS_NODE, which editor terminals (VS Code) set and which would
 * make Electron run as plain Node. Arguments are passed on (a project folder).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const main = fileURLToPath(new URL('./main.mjs', import.meta.url));
spawn(electron, [main, ...process.argv.slice(2)], { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0));
