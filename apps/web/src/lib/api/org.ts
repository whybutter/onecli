import { apiGet, apiPatch } from "./client";
import type { OrgInfo } from "./types";

export const get = () => apiGet<OrgInfo>("/v1/org");

/** PATCH /v1/org — rename (name only; `slug` is immutable, owner-only). */
export const update = (input: { name: string }) =>
  apiPatch<OrgInfo>("/v1/org", input);
