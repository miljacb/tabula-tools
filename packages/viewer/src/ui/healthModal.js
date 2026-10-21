import { findingHelpText, applyHealthScoreChipStyle, healthScoreHue } from '../features/assetHealth/findingHelp.js';
import { HEALTH_ANIM_COLUMNS, HEALTH_LIST_COLUMNS, renderHealthTh } from '../features/assetHealth/tableColumnTips.js';
import { marginalAtlasBytesForInstance, sceneAtlasMemorySummary } from '../features/perf.js';
import { formatMb, sceneVramDescription } from '../features/perfDisplay.js';
import { scene, selectionCount } from '../app/sceneStore.js';
import {
  getHealthReportForInstance,
  getHealthScanStateForInstance,
  rescanHealthForInstance,
} from '../app/session.js';

/** @typedef {import('../features/assetHealth/types.js').HealthReport} HealthReport */

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
  const inspectBtn = document.getElementById('btn-inspect-asset');
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
    detailInstanceId = id;
    detailReturnToList = opts.returnToList === true;
    if (detailBack) detailBack.hidden = !detailReturnToList;
    if (detailModal) detailModal.hidden = false;
    renderDetail(inst);
    if (!detailReturnToList) closeList();
  }

  function openList() {
    if (!listModal) return;
    listModal.hidden = false;
    renderList();
  }

  /** @param {import('../app/sceneStore.js').SpineInstance} inst */
  function renderDetail(inst) {
    if (!detailBody || !detailTitle) return;
    const report = getHealthReportForInstance(inst);
    const state = getHealthScanStateForInstance(inst);
    detailTitle.textContent = inst.name;

    if (state === 'pending' || !report) {
      detailBody.innerHTML = '<p class="health-pending">Scanning asset…</p>';
      return;
    }

    const issues = report.findings.filter((f) => f.level === 'fail' || f.level === 'warn' || f.level === 'info');
    const passed = report.findings.filter((f) => f.level === 'pass');
    const stage = scene.instances;
    const sceneVram = stage.length ? sceneAtlasMemorySummary(stage) : null;
    const ringHue = healthScoreHue(report.overallScore);
    const tips = report.scoreTips;
    const overallTip = tips?.overall ?? `Overall ${report.overallScore}.`;
    const runtimeTip = tips?.runtime ?? `Runtime ${report.runtimeScore}.`;
    const exportTip = tips?.export ?? `Export ${report.exportScore}.`;

    detailBody.innerHTML = `
      ${sceneVram ? renderSceneVramBanner(sceneVram, inst, stage) : ''}
      <div class="health-score-row">
        <div class="health-score-card health-score-card-overall" style="--health-hue: ${ringHue}" data-tip="${escapeAttr(overallTip)}">
          <span class="health-score-card-label">Overall</span>
          <span class="health-score-card-value">${report.overallScore}</span>
          <span class="health-score-card-band">${escapeHtml(report.band)}</span>
        </div>
        <div class="health-score-card" style="--health-hue: ${healthScoreHue(report.runtimeScore)}" data-tip="${escapeAttr(runtimeTip)}">
          <span class="health-score-card-label">Runtime</span>
          <span class="health-score-card-value">${report.runtimeScore}</span>
        </div>
        <div class="health-score-card" style="--health-hue: ${healthScoreHue(report.exportScore)}" data-tip="${escapeAttr(exportTip)}">
          <span class="health-score-card-label">Export</span>
          <span class="health-score-card-value">${report.exportScore}</span>
        </div>
      </div>
      ${report.worstAnimation ? `<p class="health-hint">Worst <strong>sampled</strong> runtime: <strong>${escapeHtml(report.worstAnimation)}</strong>${report.bestAnimation ? ` · Best sampled: <strong>${escapeHtml(report.bestAnimation)}</strong>` : ''}</p>` : ''}
      ${report.atlas ? `<p class="health-hint health-atlas-scan">At last scan: ~${formatMb(report.atlas.localBytes)} MB local, ~${formatMb(report.atlas.marginalBytes)} MB marginal on stage.</p>` : ''}
      <section class="health-section">
        <h3>Issues &amp; notes (${issues.length})</h3>
        <ul class="health-issues">${issues.map(renderFinding).join('') || '<li class="health-ok">No warnings or failures.</li>'}</ul>
      </section>
      <details class="health-passed">
        <summary>Passed checks (${passed.length})</summary>
        <ul class="health-issues health-issues-compact">${passed.map(renderFinding).join('')}</ul>
      </details>
      ${report.animations.length ? `
      <section class="health-section">
        <h3>Animations</h3>
        <div class="health-table-wrap">
          <table class="health-table manual-table">
            <thead><tr>${HEALTH_ANIM_COLUMNS.map(renderHealthTh).join('')}</tr></thead>
            <tbody>
              ${report.animations.map((row) => renderAnimationTableRow(row)).join('')}
            </tbody>
          </table>
        </div>
      </section>` : ''}
    `;
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
      ${sceneVram ? renderSceneVramBanner(sceneVram) : ''}
      <div class="health-table-wrap">
        <table class="health-table manual-table health-list-table">
          <thead>
            <tr>${HEALTH_LIST_COLUMNS.map(renderHealthTh).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map(({ inst, report, state }) => {
              const score = state === 'pending' || !report ? null : report.overallScore;
              const scoreLabel = score == null ? (state === 'pending' ? '…' : '—') : String(score);
              const issues = report
                ? `${report.summary.fail} fail · ${report.summary.warn} warn`
                : '—';
              const atlasMarginal = stage.length
                ? formatMb(marginalAtlasBytesForInstance(inst, stage).marginalBytes)
                : '—';
              return `
                <tr data-id="${escapeHtml(inst.id)}" tabindex="0" role="button">
                  <td><span class="health-inline-chip health-list-chip" data-score="${score ?? ''}">${scoreLabel}</span></td>
                  <td class="health-cell-name">${escapeHtml(inst.name)}</td>
                  <td>${report ? report.runtimeScore : '—'}</td>
                  <td>${report ? report.exportScore : '—'}</td>
                  <td class="health-atlas-cell" data-tip="Unique atlas VRAM on stage (live estimate)">${atlasMarginal} MB</td>
                  <td class="health-issues-cell">${issues}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    listBody.querySelectorAll('.health-list-chip').forEach((chip) => {
      const raw = chip.getAttribute('data-score');
      const num = raw === '' ? null : Number(raw);
      applyHealthScoreChipStyle(chip, num);
    });

    listBody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-id');
        if (id) openDetailForInstanceId(id, { returnToList: true });
      });
    });
  }

  function refreshChrome() {
    const count = instances().length;
    const single = selectionCount() === 1;
    if (inspectBtn) inspectBtn.disabled = !single;
    if (listBtn) listBtn.disabled = count === 0;
    if (healthLabel) {
      healthLabel.textContent = count ? `Asset health (${count})` : 'Asset health';
    }
    if (detailInstanceId && detailModal && !detailModal.hidden) {
      const inst = findById(detailInstanceId);
      if (inst) renderDetail(inst);
    }
    if (listModal && !listModal.hidden) renderList();
  }

  inspectBtn?.addEventListener('click', () => {
    if (!scene.selectedId) return;
    openDetailForInstanceId(scene.selectedId);
  });

  listBtn?.addEventListener('click', openList);

  detailClose?.addEventListener('click', closeAll);
  listClose?.addEventListener('click', closeList);

  detailBack?.addEventListener('click', () => {
    if (!detailReturnToList) return;
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
 * @param {ReturnType<typeof sceneAtlasMemorySummary>} summary
 * @param {import('../app/sceneStore.js').SpineInstance} [inst]
 * @param {import('../app/sceneStore.js').SpineInstance[]} [stage]
 */
function renderSceneVramBanner(summary, inst, stage = []) {
  const text = sceneVramDescription(summary, inst, stage);
  return `<div class="health-scene-vram"><strong>Stage atlas VRAM</strong><span>${escapeHtml(text)}</span></div>`;
}

/** @param {import('../features/assetHealth/types.js').AnimationHealthRow} row */
function renderAnimationTableRow(row) {
  const scoreTip = row.runtimeScoreTip
    || (row.runtimeSkipped
      ? 'Runtime not sampled.'
      : 'Runtime score from animation sampling.');
  const exportTips = row.exportFindingTips || [];
  const exportTip = exportTips.length
    ? exportTips.join('\n\n')
    : (row.exportWarns || row.exportFails)
      ? 'See Issues & notes for this animation.'
      : 'No export warnings or failures for this clip.';
  const exportHtml = (row.exportFails || row.exportWarns)
    ? `<span class="health-tags">${row.exportFails ? `<span class="health-tag health-tag-fail">${row.exportFails} fail</span>` : ''}${row.exportWarns ? `<span class="health-tag health-tag-warn">${row.exportWarns} warn</span>` : ''}</span>`
    : '<span class="health-export-none">—</span>';

  return `
    <tr>
      <td class="health-cell-name">${escapeHtml(row.name)}</td>
      <td class="health-num-cell">${row.duration.toFixed(2)}s</td>
      <td class="health-score-cell-wrap">
        <span class="health-inline-chip" style="--health-hue: ${healthScoreHue(row.runtimeScore)}" data-tip="${escapeAttr(scoreTip)}">${row.runtimeScore}</span>
      </td>
      <td class="health-num-cell">${row.hotDrawCalls}</td>
      <td class="health-num-cell">${row.hotVertices}</td>
      <td class="health-export-cell" data-tip="${escapeAttr(exportTip)}">${exportHtml}</td>
    </tr>
  `;
}

/** @param {string} text */
function escapeAttr(text) {
  return escapeHtml(text).replace(/\n/g, '&#10;');
}

/** @param {import('../features/assetHealth/types.js').HealthFinding} f */
function renderFinding(f) {
  const level = f.level === 'fail' ? 'Fail' : f.level === 'warn' ? 'Warn' : f.level === 'info' ? 'Info' : 'Pass';
  const tip = escapeHtml(findingHelpText(f));
  return `<li class="health-issue health-issue-${f.level}" data-tip="${tip}">
    <div class="health-issue-head">
      <span class="health-issue-level">${level}</span>
      <strong class="health-issue-title">${escapeHtml(f.title)}</strong>
    </div>
    <p class="health-issue-detail">${escapeHtml(f.detail)}</p>
  </li>`;
}

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
