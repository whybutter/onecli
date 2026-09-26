import { z } from "zod";
import {
  DIRECTORY_LIMIT_DEFAULT,
  DIRECTORY_LIMIT_MAX,
  DIRECTORY_LIMIT_MIN,
} from "../lib/directory-page";

/**
 * Zod pieces shared by every `/v1/org/*` directory-scale list query
 * (api-ee-behaviour.md §0.4): `limit` defaults to 50, clamped to 1..200 by
 * the schema itself (a request for more is a 400, not a silent clamp);
 * `cursor` is an opaque non-empty string; `q` is trimmed free text, 1..200
 * chars.
 */
export const directoryLimitSchema = z.coerce
  .number()
  .int()
  .min(DIRECTORY_LIMIT_MIN)
  .max(DIRECTORY_LIMIT_MAX)
  .default(DIRECTORY_LIMIT_DEFAULT);

export const cursorSchema = z.string().min(1).optional();
export const qSchema = z.string().trim().min(1).max(200).optional();

export const directoryListQuerySchema = z.object({
  limit: directoryLimitSchema,
  cursor: cursorSchema,
  q: qSchema,
});

export const memberListQuerySchema = directoryListQuerySchema.extend({
  status: z.enum(["active", "suspended"]).optional(),
});

/** `GET /org/members/:userId/groups` — `q` is accepted but ignored. */
export const userGroupsQuerySchema = directoryListQuerySchema;

export const groupListQuerySchema = directoryListQuerySchema.extend({
  source: z.enum(["manual", "scim"]).optional(),
});

export const createMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const memberStatusSchema = z
  .object({ status: z.enum(["active", "suspended"]) })
  .strict();

export const memberSsoExemptSchema = z
  .object({ ssoExempt: z.boolean() })
  .strict();

/** `PATCH /org/members/:userId` body: exactly one of `{ status }` or
 * `{ ssoExempt }` — a `.strict()` union member rejects the other key, so a
 * body naming both, neither, or an unknown key fails every branch. */
export const memberPatchSchema = z.union([
  memberStatusSchema,
  memberSsoExemptSchema,
]);

export const createGroupSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export const renameGroupSchema = createGroupSchema;

export const setGroupMembersSchema = z
  .object({ userIds: z.array(z.string().min(1)).max(1000) })
  .strict();

export const setWorkspaceAccessSchema = z
  .object({
    users: z
      .array(
        z.object({
          userId: z.string().min(1),
          role: z.enum(["owner", "member"]),
        }),
      )
      .max(1000),
    groupIds: z.array(z.string().min(1)).max(1000),
  })
  .strict();

export const claimDomainSchema = z
  .object({ domain: z.string().trim().min(3).max(253) })
  .strict();

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type SetGroupMembersInput = z.infer<typeof setGroupMembersSchema>;
export type SetWorkspaceAccessBody = z.infer<typeof setWorkspaceAccessSchema>;
export type ClaimDomainInput = z.infer<typeof claimDomainSchema>;
