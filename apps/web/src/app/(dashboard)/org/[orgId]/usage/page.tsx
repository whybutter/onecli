import type { Metadata } from "next";

export { default } from "@/ee/usage/usage-page";

// `usage-page.tsx` is a client component (it drives `useUsage()` directly,
// with no server-rendered shell) and so cannot export `metadata` itself —
// this wrapper module is not "use client", so Next reads it from here. Keep
// in sync with the page's own `<PageHeader title="Usage" .../>`.
export const metadata: Metadata = {
  title: "Usage",
};
