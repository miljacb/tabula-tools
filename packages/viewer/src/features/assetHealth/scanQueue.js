import { emit, scene } from '../../app/sceneStore.js';
import { inspectAsset } from './inspectAsset.js';

/** @type {Map<string, { inst: import('../../app/sceneStore.js').SpineInstance, asset: object }>} */
const pending = new Map();

/** @type {boolean} */
let draining = false;

/**
 * @param {import('../../app/sceneStore.js').SpineInstance} inst
 * @param {object} assetRecord from session assets map
 */
export function enqueueInspect(inst, assetRecord) {
  assetRecord.healthScanState = 'pending';
  assetRecord.healthReport = null;
  pending.set(inst.assetId, { inst, asset: assetRecord });
  scheduleDrain();
  emit();
}

/**
 * @param {string} assetId
 * @param {import('../../app/sceneStore.js').SpineInstance} inst
 * @param {object} assetRecord
 */
export function inspectNow(assetId, inst, assetRecord) {
  assetRecord.healthReport = inspectAsset(inst, {
    skeletonJson: assetRecord.skeletonJson,
    atlasText: assetRecord.atlasText,
    assetKey: assetRecord.assetKey,
    assetId,
  }, scene.instances);
  assetRecord.healthScanState = 'done';
  emit();
}

function scheduleDrain() {
  if (draining) return;
  draining = true;
  const run = () => {
    const next = pending.entries().next();
    if (next.done) {
      draining = false;
      return;
    }
    const [assetId, { inst, asset }] = next.value;
    pending.delete(assetId);
    try {
      inspectNow(assetId, inst, asset);
    } catch (err) {
      console.warn('Asset health scan failed', err);
      asset.healthScanState = 'done';
      asset.healthReport = {
        assetKey: asset.assetKey,
        assetId,
        scannedAt: Date.now(),
        overallScore: 0,
        runtimeScore: 0,
        exportScore: 0,
        band: 'Critical',
        summary: { pass: 0, warn: 0, fail: 1, info: 0 },
        breakdownExport: {},
        breakdownRuntime: {},
        findings: [{
          id: 'scan-error',
          level: 'fail',
          category: 'export.meta',
          title: 'Scan failed',
          detail: err instanceof Error ? err.message : String(err),
        }],
        animations: [],
        bestAnimation: null,
        worstAnimation: null,
        state: 'done',
      };
      emit();
    }
    if (pending.size) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 200 });
      } else {
        setTimeout(run, 0);
      }
    } else {
      draining = false;
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 200 });
  } else {
    setTimeout(run, 0);
  }
}
