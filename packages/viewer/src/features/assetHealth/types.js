/** @typedef {'info' | 'pass' | 'warn' | 'fail'} FindingLevel */

/**
 * @typedef {Object} HealthFinding
 * @property {string} id
 * @property {FindingLevel} level
 * @property {string} category
 * @property {string} title
 * @property {string} detail
 */

/**
 * @typedef {Object} AnimationHealthRow
 * @property {string} name
 * @property {number} duration
 * @property {number} runtimeScore
 * @property {number} exportWarns
 * @property {number} exportFails
 * @property {number} hotDrawCalls
 * @property {number} hotVertices
 * @property {boolean} [runtimeSkipped]
 * @property {string} [runtimeScoreTip]
 * @property {string[]} [exportFindingTips]
 */

/**
 * @typedef {Object} HealthReport
 * @property {string} assetKey
 * @property {string} assetId
 * @property {number} scannedAt
 * @property {number} overallScore
 * @property {number} runtimeScore
 * @property {number} exportScore
 * @property {string} band
 * @property {{ pass: number, warn: number, fail: number, info: number }} summary
 * @property {Record<string, number>} breakdownExport
 * @property {Record<string, number>} breakdownRuntime
 * @property {HealthFinding[]} findings
 * @property {AnimationHealthRow[]} animations
 * @property {string | null} bestAnimation
 * @property {string | null} worstAnimation
 * @property {'done'} state
 * @property {AtlasScanMeta} [atlas]
 * @property {{ overall: string, runtime: string, export: string }} [scoreTips]
 */

/**
 * @typedef {Object} AtlasScanMeta
 * @property {number} localBytes
 * @property {number} marginalBytes
 * @property {number} pageCount
 * @property {number} sharedPageCount
 * @property {number} sceneContentUniqueBytes
 * @property {number} sceneGpuUniqueBytes
 * @property {number} sceneStackedBytes
 */

export const RUNTIME_WEIGHT = 0.6;
export const EXPORT_WEIGHT = 0.4;
