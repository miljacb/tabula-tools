import { registerTabulaRenderer } from 'tabula-pixi';

let registered = false;

/** Register the tabula-pixi renderer plugin. Call before the Pixi Application is created. */
export function ensureTabulaRenderer() {
  if (registered) return;
  registerTabulaRenderer();
  registered = true;
}
