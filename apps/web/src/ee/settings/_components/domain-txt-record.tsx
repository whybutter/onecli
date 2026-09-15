import type { OrgDomain } from "@/lib/api/types";
import { CopyableValue } from "./copyable-value";

export interface DomainTxtRecordProps {
  domain: OrgDomain;
}

/** The DNS TXT record a claimed-but-unverified domain still needs published. */
export const DomainTxtRecord = ({ domain }: DomainTxtRecordProps) => (
  <div className="bg-muted/50 mt-2 flex flex-col gap-3 rounded-md p-3">
    <p className="text-muted-foreground text-xs">
      Add this TXT record at your DNS provider, then click Verify. Changes can
      take a few minutes to propagate.
    </p>
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-xs">
      <span className="text-muted-foreground font-medium">Type</span>
      <span className="font-mono">TXT</span>
      <span className="text-muted-foreground font-medium">Host</span>
      <span className="font-mono">@ ({domain.domain})</span>
      <span className="text-muted-foreground font-medium">Value</span>
      <CopyableValue
        value={`onecli-verification=${domain.verificationToken}`}
        copyLabel="Copy TXT record value"
      />
    </div>
  </div>
);
