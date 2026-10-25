// `pnpm dev`: the viewer, exporter and homepage dev servers together (http://localhost:5173/).
// One process so Ctrl+C stops all three; with `a & b & c` the background ones kept their ports.
import { spawn } from 'node:child_process';

const servers = [
  ['pnpm', ['--filter', 'tabula-viewer', 'exec', 'vite', '--logLevel', 'warn']],
  ['pnpm', ['exec', 'vite', '--config', 'app/vite.config.ts', '--logLevel', 'warn']],
  ['pnpm', ['--filter', 'tabula-site', 'dev']],
];
const children = servers.map(([cmd, args]) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' }));
const stop = (code = 0) => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exit(code);
};
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
