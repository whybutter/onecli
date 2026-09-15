"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { createOrganizationAction } from "@/ee/account/actions";

export interface CreateOrgFormProps {
  /** Pre-filled name ("{name}'s Org" from the session); the field stays
   * editable and the submit stays disabled while it is blank. */
  defaultName: string;
}

/** The single-field create-org card: name in, redirect into the new org. */
export const CreateOrgForm = ({ defaultName }: CreateOrgFormProps) => {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [pending, startTransition] = useTransition();

  const trimmed = name.trim();

  const submit = () => {
    if (!trimmed || pending) return;
    startTransition(async () => {
      const result = await createOrganizationAction(trimmed);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(result.data.redirectTo);
    });
  };

  return (
    <Card className="w-full max-w-lg">
      <form
        aria-label="Create a new organization"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg font-semibold">Create a new organization</h1>
          </CardTitle>
          <CardDescription>
            Organizations are a way to group your workspaces. Each organization
            can be configured with different team members.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 pt-4">
          <Label htmlFor="create-org-name">Name</Label>
          <Input
            id="create-org-name"
            name="name"
            placeholder="My Organization"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={255}
            disabled={pending}
          />
          <p className="text-muted-foreground text-xs">
            What is the name of your company or team? You can change this later.
          </p>
        </CardContent>
        <CardFooter className="justify-end pt-4">
          <Button
            type="submit"
            loading={pending}
            disabled={pending || !trimmed}
          >
            {pending ? "Creating..." : "Create organization"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
};
