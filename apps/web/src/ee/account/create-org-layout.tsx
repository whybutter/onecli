/**
 * Phase 0 stand-in for the create-org layout (logo header, theme toggle,
 * account menu). The real chrome is Phase 3 work alongside the real page;
 * a plain passthrough is enough to host the placeholder page.
 */
export default function CreateOrgLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center p-8">
      {children}
    </div>
  );
}
