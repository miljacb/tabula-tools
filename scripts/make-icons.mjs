// Regenerates the toolkit icons from packages/site/favicon.svg (the Tabula T with a wrench badge): the homepage's
// apple-touch-icon, the app page favicon, and the desktop app icon. Outputs are committed. Run: node scripts/make-icons.mjs
import { copyFile, readFile } from 'node:fs/promises';
import sharp from 'sharp';

const source = 'packages/site/favicon.svg';
const svg = await readFile(source, 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '');
const png = (s, size, file) => sharp(Buffer.from(s), { density: size * 3 }).resize(size, size).png().toFile(file);

await png(svg, 180, 'packages/site/apple-touch-icon.png');
await copyFile(source, 'app/public/favicon.svg');

// Desktop: macOS icon grid, the tile at 824/1024 centred with a margin; electron-builder converts it to .icns and .ico.
const desktop = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g transform="translate(3.125 3.125) scale(0.8047)">${inner}</g></svg>`;
await png(desktop, 1024, 'desktop/icons/icon.png');
console.log('Icons written');
