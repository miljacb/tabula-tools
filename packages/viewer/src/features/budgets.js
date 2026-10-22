/**
 * Performance budgets: limits for the whole stage that the Performance panel and the
 * health list compare against. Preset numbers are starting points for a typical slot-game
 * screen, not platform rules; pick Custom to set your own.
 */

/** @typedef {{ frameMs: number, drawCalls: number, vertices: number, vramMb: number }} BudgetLimits */

/** @type {Record<string, { label: string, limits: BudgetLimits }>} */
export const BUDGET_PRESETS = {
  'mobile-low': { label: 'Mobile · low end', limits: { frameMs: 1000 / 60, drawCalls: 30, vertices: 20000, vramMb: 128 } },
  'mobile-high': { label: 'Mobile · high end', limits: { frameMs: 1000 / 60, drawCalls: 60, vertices: 50000, vramMb: 256 } },
  desktop: { label: 'Desktop', limits: { frameMs: 1000 / 60, drawCalls: 150, vertices: 200000, vramMb: 1024 } },
};

export const DEFAULT_CUSTOM_LIMITS = { ...BUDGET_PRESETS['mobile-high'].limits };

/** @type {{ preset: string, custom: BudgetLimits }} */
let current = { preset: 'off', custom: { ...DEFAULT_CUSTOM_LIMITS } };

/** @param {{ preset?: string, custom?: Partial<BudgetLimits> } | null | undefined} state */
export function setBudget(state) {
  const preset = state?.preset && (state.preset === 'off' || state.preset === 'custom' || BUDGET_PRESETS[state.preset]) ? state.preset : 'off';
  const custom = { ...DEFAULT_CUSTOM_LIMITS };
  for (const key of /** @type {(keyof BudgetLimits)[]} */ (Object.keys(DEFAULT_CUSTOM_LIMITS))) {
    const v = Number(state?.custom?.[key]);
    if (v > 0) custom[key] = v;
  }
  current = { preset, custom };
  return getBudget();
}

export function getBudget() {
  return { preset: current.preset, custom: { ...current.custom } };
}

/** @returns {BudgetLimits | null} the active limits, or null when budgets are off */
export function activeLimits() {
  if (current.preset === 'off') return null;
  if (current.preset === 'custom') return current.custom;
  return BUDGET_PRESETS[current.preset]?.limits ?? null;
}

/** @returns {string} */
export function activeBudgetLabel() {
  if (current.preset === 'custom') return 'Custom';
  return BUDGET_PRESETS[current.preset]?.label ?? '';
}

/**
 * ok up to 80% of the limit, near up to 100%, over above it.
 * @param {number} value
 * @param {number} limit
 * @returns {'ok' | 'near' | 'over'}
 */
export function budgetLevel(value, limit) {
  if (!(limit > 0)) return 'ok';
  const ratio = value / limit;
  if (ratio > 1) return 'over';
  if (ratio > 0.8) return 'near';
  return 'ok';
}
