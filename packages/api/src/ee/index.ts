import type { Hono } from "hono";
import type { ApiEnv } from "../types";

export type RegisterEeRoutes = (app: Hono<ApiEnv>) => void;

/**
 * Enterprise route registration, mounted under `/v1` by `createApiApp`.
 *
 * Phase 0 of the v2 migration mounts nothing: every router the licensed tree
 * used to add here (org members, groups, domains, workspace access, …) is
 * rebuilt in a later phase. Until then those URLs answer with Hono's 404,
 * which is the same posture an unlicensed self-host had (a 403/404 gate in
 * front of every one of them).
 */
export const registerEeRoutes: RegisterEeRoutes = () => {};
