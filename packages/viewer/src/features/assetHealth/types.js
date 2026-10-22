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
 * @property {number} [samples] poses sampled (0 for skipped clips)
 * @property {number} [peakClipping]
 * @property {HealthFinding[]} [runtimeFindings] findings for the clip's peak pose
 * @property {HealthFinding[]} [exportFindings] export lint for this clip
 * @property {ReturnType<typeof import('./rules/exportAnimations.js').countAnimationJsonStats> | null} [stats] JSON key stats
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
 * @property {number} [setupRuntimeScore]
 * @property {SetupStats} [setup]
 */

/**
 * @typedef {Object} SetupStats
 * @property {number} bones
 * @property {number} slots
 * @property {number} vertexCount
 * @property {number} drawCalls
 * @property {number} clippingCount
 * @property {number} constraints
 * @property {string} constraintDetail
 * @property {string} blends
 * @property {number} animationCount
 * @property {number} skinCount
 */

/**
 * @typedef {Object} AtlasScanMeta
 * @property {number} localBytes
 * @property {number} marginalBytes
 * @property {number} pageCount
 * @property {number} sharedPageCount
 * @property {number} [duplicatePageCount]
 * @property {number} sceneContentUniqueBytes
 * @property {number} sceneGpuUniqueBytes
 * @property {number} sceneStackedBytes
 */

export const RUNTIME_WEIGHT = 0.6;
export const EXPORT_WEIGHT = 0.4;
