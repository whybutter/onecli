import type { Connection } from "@/lib/api";

/**
 * Props for the granular (resource-level) access editor mounted on a
 * connection's policy row. Lives in free code (not `@/ee/**`) because it is
 * the compile-time contract `lib/policy-editor/resource-scope.tsx` needs
 * regardless of which implementation backs `ResourceScopeFields` — moving it
 * here means a v2-migration replacement of the ee side never has to touch
 * this type. The ee module re-exports it for backward compatibility.
 */
export interface ResourceScopeFieldsProps {
  connection: Connection;
  /** null = all resources. */
  policy: Record<string, unknown> | null;
  onChange: (policy: Record<string, unknown> | null) => void;
  readOnly?: boolean;
  /** The org boundary, when one is set. */
  orgPolicy?: Record<string, unknown> | null;
}
