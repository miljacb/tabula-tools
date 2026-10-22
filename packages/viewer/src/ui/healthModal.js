import { CATEGORY_CAP, PENALTY } from '../features/assetHealth/grade.js';
import { findingHelp } from '../features/assetHealth/findingHelp.js';
import { EXPORT_WEIGHT, RUNTIME_WEIGHT } from '../features/assetHealth/types.js';
import { countSceneDraws, marginalAtlasBytesForInstance, sceneAtlasMemorySummary } from '../features/perf.js';
import { activeBudgetLabel, activeLimits, budgetLevel } from '../features/budgets.js';
import { formatMb, sceneVramDescription } from '../features/perfDisplay.js';
import { scene, selectionCount } from '../app/sceneStore.js';
import {
  getHealthReportForInstance,
  getHealthScanStateForInstance,
  rescanHealthForInstance,
} from '../app/session.js';
import { icon } from './icons.js';

/** @typedef {import('../features/assetHealth/types.js').HealthReport} HealthReport */
/** @typedef {import('../features/assetHealth/types.js').HealthFinding} HealthFinding */
/** @typedef {import('../features/assetHealth/types.js').AnimationHealthRow} AnimationHealthRow */


/** @type {Record<string, string>} */
const CATEGORY_LABELS = {
  'runtime.bones': 'Bones',
  'runtime.vertices': 'Vertices',
  'runtime.drawcalls': 'Draw calls',
  'runtime.clipping': 'Clipping',
  'runtime.blends': 'Blend modes',
  'runtime.constraints': 'Constraints',
  'export.skeleton': 'Skeleton',
  'export.atlas': 'Atlas',
  'export.animations': 'Animations',
  'export.meta': 'Scan',
};

const LEVEL_ORDER = { fail: 0, warn: 1, info: 2, pass: 3 };

/** @type {[string, string][]} column label, hover tip */
const LIST_COLUMNS = [
  ['Score', 'Overall health 0–100: 60% runtime + 40% export. Lower is worse.'],
  ['Skeleton', 'Click a row for the full report.'],
  ['Runtime', 'Lowest of the setup pose and every animation’s peak pose.'],
  ['Export', 'Data quality: key rates, deform/attachment density, atlas VRAM, skeleton size.'],
  ['Worst animation', 'Animation with the lowest runtime score. Empty when every animation scores 100.'],
  ['Atlas', 'Decoded atlas size of this skeleton (pixels, not file size; MB = 1024² bytes). “new”: first upload of these pages. “shared”: a lower skeleton in z-order already uses the same GPU textures, so it adds 0 MB. “duplicate”: same image file, uploaded again by a separate import — real extra VRAM.'],
  ['Issues', 'Failures and warnings from the last scan, including per-animation ones.'],
];

/** @type {[string, string][]} */
const ANIM_COLUMNS = [
  ['', ''],
  ['Animation', 'Click a row for its numbers and issues.'],
  ['Length', 'Animation length. Zero-length animations are not sampled.'],
  ['Runtime', 'Score of the peak pose: the highest vertices, draw calls and clippings seen while stepping through it.'],
  ['Peak DC', 'Most draw calls at any sampled pose.'],
  ['Peak verts', 'Most drawn vertices at any sampled pose.'],
  ['Keys/s', 'Bone, slot colour and constraint keys per second (from the JSON).'],
  ['Export', 'Data warnings and failures for this animation.'],
];

/** @type {Record<string, string>} */
const STAT_TIPS = {
  Vertices: 'Drawn vertices at the setup pose.',
  'Draw calls': 'Texture / blend-mode batches at the setup pose.',
  'Adds to stage': 'GPU memory this skeleton adds at scan time: pages that are not the same texture as a lower skeleton’s.',
  'Atlas VRAM': 'Decoded pixels incl. mipmaps, MB = 1024² bytes. Not the file size.',
  Samples: 'Poses measured: 20 per second, at most 80 per animation.',
  'Keys / s': 'Keys divided by animation length. Warn at 40, fail at 80.',
  'Deform keys': 'Mesh deform keyframes. Warn at 200, fail at 600.',
  'Attachment keys': 'Attachment swaps. Warn at 30.',
  'Draw order keys': 'Draw order changes. Warn at 20.',
  Timelines: 'Animated bone and slot properties.',
};

/** @param {[string, string][]} cols */
function gridHead(cols) {
  return `<div class="health-grid-head">${cols.map(([label, tip]) => `<span${tip ? ` data-tip="${escapeAttr(tip)}"` : ''}>${label}</span>`).join('')}</div>`;
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 * @param {(id: string) => import('../app/sceneStore.js').SpineInstance | undefined} findById
 */
export function bindHealthModals(instances, findById) {
  const detailModal = document.getElementById('health-detail-modal');
  const listModal = document.getElementById('health-list-modal');
  const detailBody = document.getElementById('health-detail-body');
  const listBody = document.getElementById('health-list-body');
  const detailTitle = document.getElementById('health-detail-title');
  const listBtn = document.getElementById('btn-asset-health');
  const healthLabel = document.getElementById('btn-asset-health-label');
  const detailClose = document.getElementById('health-detail-close');
  const detailBack = document.getElementById('health-detail-back');
  const listClose = document.getElementById('health-list-close');
  const rescanBtn = document.getElementById('health-rescan');

  /** @type {string | null} */
  let detailInstanceId = null;
  /** @type {boolean} */
  let detailReturnToList = false;

  function closeDetail() {
    if (detailModal) detailModal.hidden = true;
    detailInstanceId = null;
    detailReturnToList = false;
    if (detailBack) detailBack.hidden = true;
  }

  function closeList() {
    if (listModal) listModal.hidden = true;
  }

  function closeAll() {
    closeDetail();
    closeList();
  }

  /**
   * @param {string} id
   * @param {{ returnToList?: boolean }} [opts]
   */
  function openDetailForInstanceId(id, opts = {}) {
    const inst = findById(id);
    if (!inst) return;
    const switched = detailInstanceId !== id;
    detailInstanceId = id;
    detailReturnToList = opts.returnToList === true;
    // Back always leads to every asset's scores, even when the report was opened straight from the toolbar.
    if (detailBack) detailBack.hidden = instances().length < 2 && !detailReturnToList;
    if (detailModal) detailModal.hidden = false;
    renderDetail(inst, switched);
    if (!detailReturnToList) closeList();
  }

  function openList() {
    if (!listModal) return;
    listModal.hidden = false;
    renderList();
  }

  /**
   * @param {import('../app/sceneStore.js').SpineInstance} inst
   * @param {boolean} [fresh] true when a different asset is shown, so expanded rows reset
   */
  function renderDetail(inst, fresh = false) {
    if (!detailBody || !detailTitle) return;
    const report = getHealthReportForInstance(inst);
    const state = getHealthScanStateForInstance(inst);
    detailTitle.textContent = inst.name;

    if (state === 'pending' || !report) {
      detailBody.innerHTML = '<p class="health-pending">Scanning asset…</p>';
      return;
    }

    // Re-renders (stage changes, re-scan) keep the same rows expanded.
    // Remembers each <details> that differs from its default, so re-renders keep the user's choices.
    /** @type {Map<string, boolean>} */
    const openKeys = new Map();
    if (!fresh) {
      detailBody.querySelectorAll('details[data-key]').forEach((el) => {
        openKeys.set(/** @type {string} */ (el.getAttribute('data-key')), /** @type {HTMLDetailsElement} */ (el).open);
      });
    }
    const scrollTop = fresh ? 0 : detailBody.scrollTop;

    const stage = scene.instances;
    const sceneVram = stage.length ? sceneAtlasMemorySummary(stage) : null;

    // Clip-level export findings are listed under their animation, not in the asset issues.
    const clipFindingIds = new Set(report.animations.flatMap((row) => (row.exportFindings || []).map((f) => f.id)));
    const assetFindings = report.findings.filter((f) => !clipFindingIds.has(f.id));
    const issues = assetFindings.filter((f) => f.level !== 'pass');
    const passed = assetFindings.filter((f) => f.level === 'pass');
    const clipIssueCount = report.animations.reduce((n, row) => n + row.exportWarns + row.exportFails, 0);

    detailBody.innerHTML = `
      ${renderSummary(report)}
      ${report.setup ? renderSetupStats(report) : ''}
      ${renderBreakdown(report, openKeys)}
      ${panel('issues', 'Asset issues', issues.length, `
        ${issues.length ? renderGroupedFindings(issues, openKeys) : '<p class="health-empty">No asset-level warnings or failures.</p>'}
        ${clipIssueCount ? `<p class="health-note">${clipIssueCount} more issue(s) belong to individual animations below.</p>` : ''}
      `, openKeys, true)}
      ${report.animations.length ? panel('anims', 'Animations', report.animations.length, renderAnimations(report.animations, openKeys), openKeys, true) : ''}
      ${passed.length ? panel('passed', 'Passed checks', passed.length, `<div class="health-rows">${passed.map((f) => renderFinding(f, 1)).join('')}</div>`, openKeys, false) : ''}
      ${sceneVram ? renderSceneVramBanner(sceneVram, inst, stage) : ''}
      <p class="health-note health-scanned">Scanned ${new Date(report.scannedAt).toLocaleTimeString()}</p>
    `;
    detailBody.scrollTop = scrollTop;
  }

  function renderList() {
    if (!listBody) return;
    const stage = instances();
    const rows = stage
      .map((inst) => {
        const report = getHealthReportForInstance(inst);
        const state = getHealthScanStateForInstance(inst);
        return { inst, report, state };
      })
      .sort((a, b) => {
        const sa = a.report?.overallScore ?? (a.state === 'pending' ? 999 : -1);
        const sb = b.report?.overallScore ?? (b.state === 'pending' ? 999 : -1);
        return sa - sb;
      });

    const sceneVram = stage.length ? sceneAtlasMemorySummary(stage) : null;

    listBody.innerHTML = `
      <div class="health-grid health-list-grid">
        ${gridHead(LIST_COLUMNS)}
        ${rows.map(({ inst, report, state }, i) => {
          const score = state === 'pending' || !report ? null : report.overallScore;
          const scoreLabel = score == null ? (state === 'pending' ? '…' : '—') : String(score);
          const atlas = stage.length ? marginalAtlasBytesForInstance(inst, stage) : null;
          // Own size, then what it adds on top of lower skeletons (same GPU texture = shared, same file re-uploaded = duplicate).
          const atlasCell = !atlas || !atlas.pageCount
            ? '—'
            : `${formatMb(atlas.localBytes)} MB <span class="health-meta">${atlasNote(atlas, stage.length)}</span>`;
          return `
            <div class="health-grid-row" data-id="${escapeHtml(inst.id)}" data-stripe="${i % 2}" tabindex="0" role="button">
              <span>${scoreChip(score, scoreLabel)}</span>
              <span class="health-name">${icon('skeleton')}<span>${escapeHtml(inst.name)}</span>${report ? `<span class="health-meta">${escapeHtml(report.band)}</span>` : ''}</span>
              <span class="health-num">${report ? scoreText(report.runtimeScore) : '—'}</span>
              <span class="health-num">${report ? scoreText(report.exportScore) : '—'}</span>
              <span class="health-meta">${report?.worstAnimation && hasRuntimeLoss(report) ? escapeHtml(report.worstAnimation) : '—'}</span>
              <span class="health-num">${atlasCell}</span>
              <span>${report ? levelTags(report.summary.fail, report.summary.warn) : '—'}</span>
            </div>
          `;
        }).join('')}
      </div>
      ${sceneVram ? renderSceneVramBanner(sceneVram) : ''}
      ${renderStageBudget(stage, sceneVram)}
    `;

    listBody.querySelectorAll('.health-grid-row[data-id]').forEach((row) => {
      const open = () => {
        const id = row.getAttribute('data-id');
        if (id) openDetailForInstanceId(id, { returnToList: true });
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Enter') open();
      });
    });
  }

  function refreshChrome() {
    const count = instances().length;
    if (listBtn) {
      listBtn.disabled = count === 0;
    }
    if (healthLabel) healthLabel.textContent = 'Health';
    if (detailInstanceId && detailModal && !detailModal.hidden) {
      const inst = findById(detailInstanceId);
      if (inst) renderDetail(inst);
    }
    if (listModal && !listModal.hidden) renderList();
  }

  listBtn?.addEventListener('click', () => {
    if (selectionCount() === 1 && scene.selectedId) openDetailForInstanceId(scene.selectedId);
    else openList();
  });

  detailClose?.addEventListener('click', closeAll);
  listClose?.addEventListener('click', closeList);

  detailBack?.addEventListener('click', () => {
    if (detailModal) detailModal.hidden = true;
    detailInstanceId = null;
    detailReturnToList = false;
    if (detailBack) detailBack.hidden = true;
    openList();
  });

  detailModal?.addEventListener('click', (e) => { if (e.target === detailModal) closeAll(); });
  listModal?.addEventListener('click', (e) => { if (e.target === listModal) closeList(); });

  rescanBtn?.addEventListener('click', () => {
    if (!detailInstanceId) return;
    const inst = findById(detailInstanceId);
    if (inst) {
      rescanHealthForInstance(inst);
      renderDetail(inst);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (detailModal && !detailModal.hidden) {
      event.preventDefault();
      if (detailReturnToList) {
        detailBack?.click();
      } else {
        closeAll();
      }
      return;
    }
    if (listModal && !listModal.hidden) {
      event.preventDefault();
      closeList();
    }
  });

  return { refreshChrome, openDetailForInstanceId, openList };
}

/**
 * Collapsible section styled like a dock panel.
 * @param {string} key
 * @param {string} title
 * @param {number | null} count
 * @param {string} body
 * @param {Map<string, boolean>} openKeys
 * @param {boolean} defaultOpen
 */
function panel(key, title, count, body, openKeys, defaultOpen) {
  const open = openKeys.get(key) ?? defaultOpen;
  return `
    <details class="health-panel" data-key="${escapeAttr(key)}"${open ? ' open' : ''}>
      <summary class="health-panel-header">${twisty()}<span class="health-panel-title">${title}</span>${count == null ? '' : `<span class="health-count">${count}</span>`}</summary>
      <div class="health-panel-body">${body}</div>
    </details>
  `;
}

function twisty() {
  return `<span class="health-twisty">${icon('chevronRight', 'is-closed')}${icon('chevronDown', 'is-open')}</span>`;
}

/** @param {HealthReport} report */
function renderSummary(report) {
  const { summary } = report;
  const sampled = report.animations.filter((r) => !r.runtimeSkipped);
  const worst = sampled.length ? Math.min(...sampled.map((r) => r.runtimeScore)) : null;
  const setup = report.setupRuntimeScore;
  const runtimeHow = worst != null && setup != null
    ? `lowest of setup pose (${setup}) and worst animation${report.worstAnimation ? ` “${escapeHtml(report.worstAnimation)}”` : ''} (${worst})`
    : 'setup pose only, no animations sampled';
  const exportFindings = report.findings.filter((f) => f.category.startsWith('export.') && PENALTY[f.level]);
  const exportHow = exportFindings.length
    ? `100 minus ${exportFindings.length} data issue(s), at most −${CATEGORY_CAP} per category`
    : 'no data issues found';

  return `
    <div class="health-summary">
      <div class="health-overall tone-${tone(report.overallScore)}" data-tip="${escapeAttr(report.scoreTips?.overall ?? '')}">
        <span class="health-overall-value">${report.overallScore}</span>
        <span class="health-overall-band">${escapeHtml(report.band)}</span>
      </div>
      <div class="health-summary-rows">
        ${renderSubscore('Runtime', report.runtimeScore, RUNTIME_WEIGHT, runtimeHow, report.scoreTips?.runtime)}
        ${renderSubscore('Export', report.exportScore, EXPORT_WEIGHT, exportHow, report.scoreTips?.export)}
        <div class="health-tally">
          ${tally('fail', summary.fail, 'failed')}
          ${tally('warn', summary.warn, 'warnings')}
          ${tally('info', summary.info, 'notes')}
          ${tally('pass', summary.pass, 'passed')}
        </div>
      </div>
    </div>
  `;
}

/**
 * @param {string} label
 * @param {number} score
 * @param {number} weight
 * @param {string} how already-escaped HTML
 * @param {string} [tip]
 */
function renderSubscore(label, score, weight, how, tip = '') {
  return `
    <div class="health-subscore tone-${tone(score)}"${tip ? ` data-tip="${escapeAttr(tip)}"` : ''}>
      <span class="health-label">${label}:</span>
      <span class="health-value">${score}</span>
      <span class="health-bar"><span style="width: ${Math.max(0, Math.min(100, score))}%"></span></span>
      <span class="health-meta">${Math.round(weight * 100)}% of overall · ${how}</span>
    </div>
  `;
}

/**
 * @param {string} level
 * @param {number} count
 * @param {string} label
 */
function tally(level, count, label) {
  return `<span class="health-tally-item${count ? ` is-${level}` : ''}"><strong>${count}</strong> ${label}</span>`;
}

/** @param {HealthReport} report */
function renderSetupStats(report) {
  const s = /** @type {NonNullable<HealthReport['setup']>} */ (report.setup);
  const atlas = report.atlas;
  /** @type {[string, string][]} */
  const cells = [
    ['Bones', String(s.bones)],
    ['Slots', String(s.slots)],
    ['Vertices', String(s.vertexCount)],
    ['Draw calls', String(s.drawCalls)],
    ['Clippings', String(s.clippingCount)],
    ['Constraints', s.constraintDetail ? `${s.constraints} (${s.constraintDetail})` : String(s.constraints)],
    ['Skins', String(s.skinCount)],
    ['Animations', String(s.animationCount)],
  ];
  if (atlas) {
    cells.push(
      ['Atlas VRAM', `${formatMb(atlas.localBytes)} MB · ${atlas.pageCount} page(s)`],
      ['Adds to stage', `${formatMb(atlas.marginalBytes)} MB`],
    );
  }
  if (s.blends && s.blends !== 'None') cells.push(['Blend modes', s.blends]);
  return `
    <div class="health-block">
      <h3 class="health-block-title">Setup pose</h3>
      ${statList(cells)}
    </div>
  `;
}

/** @param {[string, string][]} cells */
function statList(cells) {
  return `<div class="health-stats">${cells.map(([label, value]) => `<div><span class="health-label"${STAT_TIPS[label] ? ` data-tip="${escapeAttr(STAT_TIPS[label])}"` : ''}>${label}:</span><span class="health-value">${escapeHtml(value)}</span></div>`).join('')}</div>`;
}

/**
 * @param {HealthReport} report
 * @param {Map<string, boolean>} openKeys
 */
function renderBreakdown(report, openKeys) {
  /** @type {{ area: string, category: string, points: number }[]} */
  const rows = [
    ...Object.entries(report.breakdownRuntime || {}).map(([category, points]) => ({ area: 'Runtime · setup', category, points })),
    ...Object.entries(report.breakdownExport || {}).map(([category, points]) => ({ area: 'Export', category, points })),
  ].filter((r) => r.points > 0).sort((a, b) => b.points - a.points);
  if (!rows.length) return '';
  return panel('breakdown', 'Where points are lost', null, `
    <div class="health-rows">
      ${rows.map((r, i) => `
        <div class="health-row" data-depth="1" data-stripe="${i % 2}">
          <span class="health-name">${escapeHtml(CATEGORY_LABELS[r.category] ?? r.category)}</span>
          <span class="health-meta">${r.area}</span>
          <span class="health-bar health-bar-loss"><span style="width: ${(r.points / CATEGORY_CAP) * 100}%"></span></span>
          <span class="health-cost">−${r.points}${r.points >= CATEGORY_CAP ? ' (cap)' : ''}</span>
        </div>`).join('')}
    </div>
    <p class="health-note">Warn −${PENALTY.warn}, fail −${PENALTY.fail}, capped at −${CATEGORY_CAP} per category. Animation runtime scores use the same rules on each animation’s peak pose.</p>
  `, openKeys, true);
}

/**
 * @param {HealthFinding[]} findings
 * @param {Map<string, boolean>} openKeys
 */
function renderGroupedFindings(findings, openKeys) {
  /** @type {Map<string, HealthFinding[]>} */
  const groups = new Map();
  for (const f of [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])) {
    if (!groups.has(f.category)) groups.set(f.category, []);
    groups.get(f.category)?.push(f);
  }
  return [...groups.entries()].map(([category, list]) => {
    const key = `group:${category}`;
    const open = openKeys.get(key) ?? true;
    return `
      <details class="health-group" data-key="${escapeAttr(key)}"${open ? ' open' : ''}>
        <summary class="health-row is-group" data-depth="1">${twisty()}<span class="health-name">${category.startsWith('runtime.') ? 'Runtime' : 'Export'} · ${escapeHtml(CATEGORY_LABELS[category] ?? category)}</span><span class="health-meta">${list.length}</span></summary>
        ${list.map((f) => renderFinding(f, 2)).join('')}
      </details>
    `;
  }).join('');
}

/**
 * @param {HealthFinding} f
 * @param {number} depth
 */
function renderFinding(f, depth) {
  const help = f.level === 'pass' ? null : findingHelp(f);
  const cost = PENALTY[f.level] ? `<span class="health-cost">−${PENALTY[f.level]}</span>` : '';
  return `<div class="health-finding" data-depth="${depth}">
    <div class="health-finding-head">
      <span class="health-level is-${f.level}">${f.level}</span>
      <span class="health-name">${escapeHtml(f.title)}</span>
      ${cost}
    </div>
    <p class="health-finding-text">${escapeHtml(f.detail)}</p>
    ${help ? `<p class="health-finding-text is-help">${escapeHtml(help.what)} <strong>Fix:</strong> ${escapeHtml(help.fix)}</p>` : ''}
  </div>`;
}

/**
 * @param {AnimationHealthRow[]} rows
 * @param {Map<string, boolean>} openKeys
 */
function renderAnimations(rows, openKeys) {
  // Worst first; zero-length animations (not sampled) last.
  const sorted = [...rows].sort((a, b) => {
    if (a.runtimeSkipped !== b.runtimeSkipped) return a.runtimeSkipped ? 1 : -1;
    return a.runtimeScore - b.runtimeScore || (b.exportFails + b.exportWarns) - (a.exportFails + a.exportWarns);
  });
  return `
    <div class="health-grid health-anim-grid">
      ${gridHead(ANIM_COLUMNS)}
      ${sorted.map((row, i) => renderAnimationRow(row, openKeys.get(`anim:${row.name}`) ?? false, i)).join('')}
    </div>
  `;
}

/**
 * @param {AnimationHealthRow} row
 * @param {boolean} open
 * @param {number} index
 */
function renderAnimationRow(row, open, index) {
  const stats = row.stats;
  const kps = stats && row.duration > 0 ? stats.keys / row.duration : null;
  const runtimeIssues = (row.runtimeFindings || []).filter((f) => f.level === 'warn' || f.level === 'fail');
  const exportIssues = (row.exportFindings || []).filter((f) => f.level !== 'pass');
  const skipped = row.runtimeSkipped;
  const score = skipped
    ? scoreChip(null, '—', row.runtimeScoreTip)
    : scoreChip(row.runtimeScore, String(row.runtimeScore), row.runtimeScoreTip);

  /** @type {[string, string][]} */
  const cells = [];
  if (!skipped) {
    cells.push(
      ['Samples', String(row.samples ?? '—')],
      ['Peak draw calls', String(row.hotDrawCalls)],
      ['Peak vertices', String(row.hotVertices)],
      ['Peak clippings', String(row.peakClipping ?? 0)],
    );
  }
  if (stats) {
    cells.push(
      ['Keys', String(stats.keys)],
      ['Keys / s', kps == null ? '—' : String(Math.round(kps))],
      ['Timelines', String(stats.timelines)],
      ['Constraint keys', String(stats.constraintKeys)],
      ['Deform keys', String(stats.deformKeys)],
      ['Attachment keys', String(stats.attachmentSwitches)],
      ['Draw order keys', String(stats.drawOrderKeys)],
      ['Events', String(stats.events)],
    );
  }

  return `
    <details class="health-anim" data-key="anim:${escapeAttr(row.name)}"${open ? ' open' : ''}>
      <summary class="health-grid-row" data-stripe="${index % 2}">
        ${twisty()}
        <span class="health-name">${escapeHtml(row.name)}</span>
        <span class="health-num">${row.duration.toFixed(2)}s</span>
        <span>${score}</span>
        <span class="health-num">${skipped ? '—' : row.hotDrawCalls}</span>
        <span class="health-num">${skipped ? '—' : row.hotVertices}</span>
        <span class="health-num">${kps == null ? '—' : Math.round(kps)}</span>
        <span>${levelTags(row.exportFails, row.exportWarns)}</span>
      </summary>
      <div class="health-anim-body">
        ${cells.length ? statList(cells) : ''}
        ${skipped ? '<p class="health-note">Zero-length animation: runtime not sampled and not counted in the score.</p>' : ''}
        ${runtimeIssues.length || exportIssues.length
          ? [...runtimeIssues, ...exportIssues].map((f) => renderFinding(f, 2)).join('')
          : '<p class="health-empty">No issues in this animation.</p>'}
      </div>
    </details>
  `;
}

/**
 * @param {ReturnType<typeof marginalAtlasBytesForInstance>} m
 * @param {number} stageCount
 */
function atlasNote(m, stageCount) {
  if (stageCount < 2) return '';
  if (m.sharedPageCount === m.pageCount) return 'shared';
  if (m.duplicatePageCount === m.pageCount) return 'duplicate';
  if (!m.sharedPageCount && !m.duplicatePageCount) return 'new';
  const bits = [`+${formatMb(m.marginalBytes)} MB`];
  if (m.duplicatePageCount) bits.push(`${m.duplicatePageCount} dup`);
  return bits.join(' · ');
}

/**
 * The stage against the Performance panel's budget: draw calls and vertices with every visible skeleton drawn together, and atlas VRAM.
 * @param {import('../app/sceneStore.js').SpineInstance[]} stage
 * @param {ReturnType<typeof sceneAtlasMemorySummary> | null} vram
 */
function renderStageBudget(stage, vram) {
  const limits = activeLimits();
  if (!limits || !stage.length) return '';
  const draws = countSceneDraws(stage);
  const vramMb = vram ? vram.gpuUniqueBytes / (1024 * 1024) : 0;
  /** @type {[string, number, number, string][]} */
  const items = [
    ['Draw calls', draws.drawCalls, limits.drawCalls, String(draws.drawCalls)],
    ['Vertices', draws.vertices, limits.vertices, draws.vertices.toLocaleString('en-US')],
    ['Atlas VRAM', vramMb, limits.vramMb, `${vramMb.toFixed(1)} MB`],
  ];
  return `<p class="health-budget">Stage vs ${escapeHtml(activeBudgetLabel())} budget: ${items.map(([label, value, limit, text]) => `${label} <span class="is-${budgetLevel(value, limit)}">${text} / ${limit.toLocaleString('en-US')}</span>`).join(' · ')}. Frame time is in the Performance panel.</p>`;
}

/** @param {HealthReport} report */
function hasRuntimeLoss(report) {
  return report.animations.some((r) => !r.runtimeSkipped && r.runtimeScore < 100);
}

/** @param {number} score */
function tone(score) {
  if (score >= 85) return 'good';
  if (score >= 55) return 'mid';
  return 'bad';
}

/**
 * @param {number | null} score
 * @param {string} label
 * @param {string} [tip]
 */
function scoreChip(score, label, tip = '') {
  return `<span class="health-chip tone-${score == null ? 'none' : tone(score)}"${tip ? ` data-tip="${escapeAttr(tip)}"` : ''}>${label}</span>`;
}

/** @param {number} score */
function scoreText(score) {
  return `<span class="health-score-text tone-${tone(score)}">${score}</span>`;
}

/**
 * @param {number} fail
 * @param {number} warn
 */
function levelTags(fail, warn) {
  if (!fail && !warn) return '<span class="health-meta">—</span>';
  return `<span class="health-tags">${fail ? `<span class="health-level is-fail">${fail} fail</span>` : ''}${warn ? `<span class="health-level is-warn">${warn} warn</span>` : ''}</span>`;
}

/**
 * @param {ReturnType<typeof sceneAtlasMemorySummary>} summary
 * @param {import('../app/sceneStore.js').SpineInstance} [inst]
 * @param {import('../app/sceneStore.js').SpineInstance[]} [stage]
 */
function renderSceneVramBanner(summary, inst, stage = []) {
  const text = sceneVramDescription(summary, inst, stage);
  return `<div class="health-block"><h3 class="health-block-title">Stage atlas VRAM</h3><p class="health-note">${escapeHtml(text)}</p></div>`;
}

/** @param {string} text */
function escapeAttr(text) {
  return escapeHtml(text).replace(/\n/g, '&#10;');
}

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
