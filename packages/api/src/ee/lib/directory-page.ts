import { ServiceError } from "../../services/errors";

/**
 * Opaque keyset-cursor helpers for the directory-scale list envelope
 * (api-ee-behaviour.md §0.4): every `/v1/org/*` directory list answers with
 * `{ data, nextCursor }`. The cursor is a base64url-encoded JSON object of
 * string values, encoding the ordering key of the last row on the page —
 * callers never parse it themselves, they only ever echo it back.
 *
 * Unlike a "malformed cursor silently serves page one" design, the spec's law
 * is stricter: a cursor that IS present but is malformed, truncated, or
 * carries a non-string value is a 400 `ServiceError("BAD_REQUEST", "Invalid
 * cursor")` — never a silent reset. Only the ABSENCE of a cursor means "first
 * page".
 *
 * Pure and dependency-light; shared by every directory list in `ee/`.
 */

export interface DirectoryPage<T> {
  data: T[];
  nextCursor: string | null;
}

export const DIRECTORY_LIMIT_MIN = 1;
export const DIRECTORY_LIMIT_MAX = 200;
export const DIRECTORY_LIMIT_DEFAULT = 50;

const invalidCursor = () => new ServiceError("BAD_REQUEST", "Invalid cursor");

/** Encode an ordering key (e.g. `{ createdAt, userId }`) into an opaque cursor. */
export const encodeCursor = (parts: Record<string, string>): string =>
  Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");

/**
 * Decode a cursor into its named keyset parts.
 *
 * - `undefined` input (no cursor given) → `undefined`: serve the first page.
 * - Present but malformed (bad base64/JSON, not an object, wrong key set, or
 *   any non-string value) → throws `ServiceError("BAD_REQUEST", "Invalid
 *   cursor")`, per §0.4.
 */
export const decodeCursor = <K extends string>(
  raw: string | undefined,
  keys: readonly K[],
): Record<K, string> | undefined => {
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }

  const obj = parsed as Record<string, unknown>;
  const objKeys = Object.keys(obj);
  if (
    objKeys.length !== keys.length ||
    !keys.every((key) => objKeys.includes(key))
  ) {
    throw invalidCursor();
  }

  const result = {} as Record<K, string>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value !== "string" || value.length === 0) throw invalidCursor();
    result[key] = value;
  }
  return result;
};

/**
 * Parse a cursor's date component. An unparsable date is exactly as malformed
 * as a bad cursor shape, so it throws the same "Invalid cursor" error rather
 * than handing an Invalid Date to the query layer.
 */
export const parseCursorDate = (raw: string): Date => {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw invalidCursor();
  return date;
};

/**
 * Clamp a requested page size into `[1, 200]`. The route query schemas reject
 * out-of-range values outright (400); this is the service-level backstop so a
 * direct caller (a test, another service) can never ask for an unbounded page.
 */
export const clampDirectoryLimit = (limit?: number): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DIRECTORY_LIMIT_DEFAULT;
  }
  return Math.min(
    DIRECTORY_LIMIT_MAX,
    Math.max(DIRECTORY_LIMIT_MIN, Math.trunc(limit)),
  );
};

/**
 * Build the page envelope from an over-fetched row set: query `limit + 1`
 * rows, hand them here, and the extra row (if any) becomes the `nextCursor`
 * signal rather than a separate count query. `keyOf` must return the SAME
 * ordering key the query sorts by, or pagination will skip or repeat rows.
 */
export const toDirectoryPage = <T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => Record<string, string>,
): DirectoryPage<T> => {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    nextCursor: last === undefined ? null : encodeCursor(keyOf(last)),
  };
};
