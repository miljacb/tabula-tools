// Regenerates the Viewer's PNG icons from public/favicon.svg (Studio's mark on its dark tile, plus an eye badge
// so the view-only tool reads apart from Studio): apple-touch-icon, PWA 192/512 and a maskable 512. Outputs are committed.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const pub=path.resolve(import.meta.dirname,'../public');
const svg=await readFile(path.join(pub,'favicon.svg'),'utf8');
const inner=svg.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g,'');
// Maskable: square full-bleed tile, artwork shrunk into the 80% safe zone.
const MASKABLE=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#1b1f27"/><g transform="translate(3.2 3.2) scale(0.8)">${inner}</g></svg>`;
const png=(s,size,file)=>sharp(Buffer.from(s),{density:size*3}).resize(size,size).png().toFile(path.join(pub,file));
await png(svg,180,'apple-touch-icon.png');
await png(svg,192,'icons/icon-192.png');
await png(svg,512,'icons/icon-512.png');
await png(MASKABLE,512,'icons/icon-maskable-512.png');
console.log('Icons written to',pub);
