"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useUpdateOrg } from "@/hooks/use-org";

export interface OrgDetailsFormProps {
  orgId: string;
  orgName: string;
  readOnly?: boolean;
}

export const OrgDetailsForm = ({
  orgId,
  orgName,
  readOnly,
}: OrgDetailsFormProps) => {
  const [name, setName] = useState(orgName);
  const { copied, copy } = useCopyToClipboard();
  const updateOrg = useUpdateOrg();

  const isDirty = name.trim() !== orgName;

  const handleSave = () => {
    if (!isDirty || updateOrg.isPending) return;
    updateOrg.mutate(
      { name: name.trim() },
      { onSuccess: () => toast.success("Organization updated") },
    );
  };

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="grid gap-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={readOnly}
          disabled={updateOrg.isPending}
          className={
            readOnly ? "text-muted-foreground cursor-not-allowed" : undefined
          }
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="org-id">Organization ID</Label>
        <div className="flex gap-2">
          <Input
            id="org-id"
            value={orgId}
            readOnly
            className="text-muted-foreground"
          />
          <Button type="button" variant="outline" onClick={() => copy(orgId)}>
            {copied ? (
              <>
                <Check />
                Copied
              </>
            ) : (
              <>
                <Copy />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>

      {!readOnly && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setName(orgName)}
            disabled={!isDirty || updateOrg.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            loading={updateOrg.isPending}
            disabled={!isDirty || updateOrg.isPending}
          >
            {updateOrg.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </Card>
  );
};
