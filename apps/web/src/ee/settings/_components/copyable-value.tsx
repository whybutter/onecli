"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface CopyableValueProps {
  value: string;
  copyLabel: string;
}

/** A truncating mono value with its own copy-icon button and copied state. */
export const CopyableValue = ({ value, copyLabel }: CopyableValueProps) => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copyLabel}
        onClick={() => copy(value)}
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
      </Button>
    </div>
  );
};
