"use client";

import dynamic from "next/dynamic";
import { granularAccessConfigs } from "@/lib/granular-access";
import type { ResourceScopeFieldsProps } from "@/lib/policy-editor/resource-scope-types";

export type { ResourceScopeFieldsProps };

// Loaded on demand so the provider pickers (the GitHub repository browser and
// whatever joins it) stay out of the shared policy-editor chunk — the summary
// row is cheap, the picker is not.
const EeResourceScopeFields = dynamic(
  () =>
    import("@/ee/policy-editor/_components/resource-scope-fields").then(
      (m) => m.ResourceScopeFields,
    ),
  { ssr: false },
);

/**
 * Granular per-resource scoping (which repositories / folders a connection's
 * injected credential may reach). The real editor renders for every provider
 * that ships a picker (`config.PolicyDialogContent`); a provider that is
 * scopable at the gateway but has no picker here yet (Dropbox — its folder
 * browser needs a live-browse endpoint this edition does not run) shows a
 * plain hint instead, so the row never looks like a missing feature.
 */
export const ResourceScopeFields = (props: ResourceScopeFieldsProps) => {
  const { connection, readOnly = false } = props;
  const meta = (connection.metadata as Record<string, unknown> | null) ?? {};
  const config = granularAccessConfigs.get(connection.provider);
  if (!config?.isSupported(meta)) return null;
  if (config.PolicyDialogContent) return <EeResourceScopeFields {...props} />;
  if (readOnly) return null;
  return (
    <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
      Resource scoping (limiting this connection to specific{" "}
      {config.itemLabel.plural}) is not available for this app yet.
    </p>
  );
};
