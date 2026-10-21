import { ClipView } from 'tabula-pixi';

/**
 * A tabula-pixi view the viewer drives itself (no ticker): `update(dt)` advances the clip.
 * `state` is the multi-track AnimationState; reading it switches the clip to multi-track playback.
 */
export class TabulaView extends ClipView {
  /** @param {import('tabula-pixi').TabulaAsset} asset */
  constructor(asset) {
    super(asset);
    this.autoUpdate = false;
  }

  get skeleton() {
    return this.clip.skeleton;
  }

  get state() {
    return this.clip.state;
  }
}
