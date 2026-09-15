/**
 * Billing plans, kept only as the vocabulary the free web code speaks.
 *
 * This build has no billing: every organization reports the top tier, every
 * plan comparison passes, and the plan limits are effectively unbounded.
 * The types stay so the free callers (`plan-gate`, the workspaces page, the
 * team page, the account audit-log retention) compile unchanged until they
 * are simplified in a later phase.
 */
export type Plan =
  | "free"
  | "pro"
  | "team"
  | "team-legacy"
  | "scale"
  | "enterprise"
  | "aws-marketplace";

/** `Organization.subscriptionStatus` as Stripe (and the seed default) wrote it. */
export type SubscriptionStatus =
  | Plan
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface PlanLimits {
  /** How far back the account audit log reaches, in days. */
  auditLogDays: number;
  maxWorkspaces: number;
  maxAgents: number;
  maxSecrets: number;
  maxMembers: number;
  maxOAuthApps: number;
}

export interface PlanConfig {
  name: string;
  limits: PlanLimits;
}

/** The plan every organization is on in this build. */
export const EFFECTIVE_PLAN: Plan = "enterprise";

/**
 * A finite, generous retention window rather than `Infinity`: the one free
 * reader does date arithmetic with it (`setDate(today - days)`), and a
 * non-finite value would produce an invalid cutoff.
 */
export const AUDIT_LOG_RETENTION_DAYS = 365;

const ENTERPRISE_CONFIG: PlanConfig = {
  name: "Enterprise",
  limits: {
    auditLogDays: AUDIT_LOG_RETENTION_DAYS,
    maxWorkspaces: Number.MAX_SAFE_INTEGER,
    maxAgents: Number.MAX_SAFE_INTEGER,
    maxSecrets: Number.MAX_SAFE_INTEGER,
    maxMembers: Number.MAX_SAFE_INTEGER,
    maxOAuthApps: Number.MAX_SAFE_INTEGER,
  },
};

export type NormalizePlan = (status: SubscriptionStatus | string) => Plan;
export type IsPlanAtLeast = (plan: Plan, minimum: Plan) => boolean;
export type GetPlanConfig = (plan: Plan) => PlanConfig;

/** Whatever the subscription column says, the organization is on the top tier. */
export const normalizePlan: NormalizePlan = () => EFFECTIVE_PLAN;

/** There is no plan below the effective one, so every threshold is met. */
export const isPlanAtLeast: IsPlanAtLeast = () => true;

export const getPlanConfig: GetPlanConfig = () => ENTERPRISE_CONFIG;
