/**
 * Plan configuration — the ONE place a limit or a feature flag's default
 * lives. `checkQuota()`/`hasFeature()` (service.ts) read this, never a
 * literal number scattered through a feature. No price, currency, or
 * billing-provider concept lives here (Section 6/12: no payment
 * integration yet) — a "plan" is just a named bundle of limits until a real
 * billing provider is wired up.
 *
 * A workspace's own `quotaOverrides` (nullable JSON) wins over its plan's
 * default for any key it sets — the escape hatch for a manually-negotiated
 * customer limit without inventing a new plan name.
 */
export type UsageKind =
  | 'ai_request' | 'ai_tokens' | 'agent_task' | 'research_task'
  | 'media_analysis' | 'message' | 'lead_processed';

/** Gauges are a live count/sum, not an accumulating event total — checked against the CURRENT value, not a period sum. */
export type GaugeKind = 'agents' | 'storage_bytes';

export type PlanLimits = Partial<Record<UsageKind, number>> & Partial<Record<GaugeKind, number>>;

/** undefined/missing key = unlimited for that kind. Deliberately generous defaults so no existing test suite trips a limit by accident — these are safety ceilings, not a pricing page. */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    ai_request: 1000, agent_task: 500, research_task: 300, media_analysis: 20,
    message: 500, lead_processed: 20_000, agents: 20, storage_bytes: 500 * 1024 * 1024, // 500MB
  },
  pro: {
    ai_request: 20_000, agent_task: 10_000, research_task: 5_000, media_analysis: 500,
    message: 20_000, lead_processed: 500_000, agents: 100, storage_bytes: 20 * 1024 * 1024 * 1024, // 20GB
  },
  // No cap on anything not listed here (e.g. an "internal"/"unlimited" plan a future admin tool could set).
};

export const DEFAULT_PLAN = 'free';

export const PERIOD_DAYS = 30; // a rolling window, not calendar-month billing — no billing provider to align to yet

export type FeatureFlag = 'command_center' | 'media_analysis' | 'social_research';

/** Every feature this build actually gates is on by default — a flag here is for a future "disable for this workspace" override, not a paywall (Section 12: no payment integration yet). */
const DEFAULT_FEATURES: Record<FeatureFlag, boolean> = {
  command_center: true,
  media_analysis: true,
  social_research: true,
};

export function planLimits(plan: string, overrides: unknown): PlanLimits {
  const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS[DEFAULT_PLAN];
  const override = (overrides && typeof overrides === 'object') ? (overrides as PlanLimits) : {};
  return { ...base, ...override };
}

export function isFeatureEnabled(flag: FeatureFlag, featureFlags: unknown): boolean {
  const flags = (featureFlags && typeof featureFlags === 'object') ? (featureFlags as Record<string, boolean>) : {};
  return flags[flag] ?? DEFAULT_FEATURES[flag];
}
