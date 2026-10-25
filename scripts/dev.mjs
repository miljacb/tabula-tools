// `pnpm dev`: the viewer, exporter and homepage dev servers together (http://localhost:5173/).
// One process so Ctrl+C stops all three; with `a & b & c` the background ones kept their ports.
// Each server runs in its own process group, stopped as a whole: killing only `pnpm` left its `vite`
// running on the port. No server reads the terminal (Vite's key shortcuts): three readers of one TTY
// crash with `read EIO` once this script exits.
import { spawn } from 'node:child_process';

const servers = [
  ['viewer', 'pnpm', ['--filter', 'tabula-viewer', 'exec', 'vite', '--logLevel', 'warn']],
  ['exporter', 'pnpm', ['exec', 'vite', '--config', 'app/vite.config.ts', '--logLevel', 'warn']],
  ['site', 'pnpm', ['--filter', 'tabula-site', 'dev']],
];
const windows = process.platform === 'win32';
const children = servers.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: windows, detached: !windows });
  child.name = name;
  return child;
});

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (windows) child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM'); // the group: pnpm and its vite
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
};
for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping) console.error(`\n${child.name} dev server stopped${code ? ` (exit ${code})` : ''}: stopping the others.`);
    stop(code ?? 0);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop());
