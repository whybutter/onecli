/**
 * Operator pings to a Discord webhook (signups, onboarding, app requests,
 * billing events) are a hosted-platform concern and are dropped here. The
 * event vocabulary is kept so the free callers stay typed.
 */
export type EventType =
  | "user_signup"
  | "onboarding_completed"
  | "app_requested"
  | "reviewer_login"
  | "email_reply"
  | "payment_succeeded"
  | "subscription_cancelled"
  | "payment_failed";

export type EventPayload = Record<EventType, Record<string, unknown>>;

export type NotifyDiscord = <T extends EventType>(
  event: T,
  data: EventPayload[T],
) => void;

export const notifyDiscord: NotifyDiscord = () => {};
