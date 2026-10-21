import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
mkdirSync(root, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(width, height, paint) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y, width, height);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function atlas(page, region, size) {
  return `${page}
size: ${size},${size}
format: RGBA8888
filter: Linear,Linear
repeat: none
${region}
  rotate: false
  xy: 0, 0
  size: ${size}, ${size}
  orig: ${size}, ${size}
  offset: 0, 0
  index: -1
`;
}

const box = {
  skeleton: { hash: 'sample-box', spine: '4.2.0', x: -32, y: -32, width: 64, height: 96 },
  bones: [
    { name: 'root' },
    { name: 'tip', parent: 'root', length: 40, y: 40 },
  ],
  slots: [{ name: 'box', bone: 'root', attachment: 'box' }],
  skins: [{
    name: 'default',
    attachments: {
      box: { box: { width: 64, height: 64 } },
    },
  }],
  animations: {
    idle: {
      bones: {
        tip: {
          rotate: [
            { time: 0, value: -8 },
            { time: 1, value: 8 },
            { time: 2, value: -8 },
          ],
        },
      },
    },
    pulse: {
      bones: {
        root: {
          scale: [
            { time: 0, x: 1, y: 1 },
            { time: 0.5, x: 1.08, y: 1.08 },
            { time: 1, x: 1, y: 1 },
          ],
        },
      },
    },
  },
};

const badge = {
  skeleton: { hash: 'sample-badge', spine: '4.2.0', x: -24, y: -24, width: 48, height: 48 },
  bones: [
    { name: 'root' },
    { name: 'bob', parent: 'root', y: 8 },
  ],
  slots: [{ name: 'badge', bone: 'bob', attachment: 'badge' }],
  skins: [
    { name: 'default', attachments: { badge: { badge: { width: 48, height: 48 } } } },
    { name: 'plain', attachments: {} },
  ],
  animations: {
    bob: {
      bones: {
        bob: {
          translate: [
            { time: 0, y: 0 },
            { time: 0.4, y: 10 },
            { time: 0.8, y: 0 },
          ],
        },
      },
    },
  },
};

writeFileSync(join(root, 'box.png'), png(64, 64, (x, y, w, h) => {
  const edge = x < 3 || y < 3 || x > w - 4 || y > h - 4;
  return edge ? [255, 255, 255, 255] : [64, 140, 220, 255];
}));
writeFileSync(join(root, 'badge.png'), png(48, 48, (x, y, w, h) => {
  const edge = x < 3 || y < 3 || x > w - 4 || y > h - 4;
  return edge ? [40, 24, 8, 255] : [230, 140, 40, 255];
}));
writeFileSync(join(root, 'box.atlas'), atlas('box.png', 'box', 64));
writeFileSync(join(root, 'badge.atlas'), atlas('badge.png', 'badge', 48));
writeFileSync(join(root, 'box.json'), JSON.stringify(box, null, 2));
writeFileSync(join(root, 'badge.json'), JSON.stringify(badge, null, 2));
console.log('samples written to', root);
