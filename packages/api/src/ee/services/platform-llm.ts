import type { PlatformLlmProvider } from "../../providers/platform-llm";

/** The platform's Anthropic trial credit is a hosted-only offer: never applies. */
export const eePlatformLlm: PlatformLlmProvider = {
  trialCreditApplies: () => false,
};
