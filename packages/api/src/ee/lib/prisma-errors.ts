/**
 * Prisma's unique-violation code, matched structurally rather than by
 * `instanceof Prisma.PrismaClientKnownRequestError` so a test double's error
 * (a plain `{ code: "P2002" }` throw) reads the same as the real client's —
 * see `workspace-service.ts`'s original note. Shared by every `ee/services`
 * file that pre-checks a unique constraint and still wants to catch the
 * concurrent-writer race the pre-check can't see.
 */
export const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: unknown }).code === "P2002";
