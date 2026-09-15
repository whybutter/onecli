/**
 * AWS Marketplace metering is dropped. The api-server calls this once at
 * boot; `null` means "no job scheduled", exactly what an unconfigured
 * listing produced.
 */
export const startAwsMarketplaceMeteringJob = (): NodeJS.Timeout | null => null;
