"use client";

import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { CustomConnectionApprovalRow } from "./custom-connection-approval-row";
import { GenericActionApprovalRow } from "./generic-action-approval-row";
import { ContactBlockedCard } from "./contact-blocked-card";
import { ChooseSenderCard } from "./choose-sender-card";

interface ActionApprovalRowProps {
  item: PendingActionApprovalItem;
  /** The bell (every agent's asks): cards that hide the agent in its own
   * chat name it here. */
  showAgent?: boolean;
}

/**
 * One pending action approval (bell and inline chat). An agent-proposed
 * custom connection needs the key typed in, so it gets its own card and its
 * own approve door. A row whose payload no longer validates
 * (customConnection null) falls back to the generic row, whose approve the
 * server refuses for that action, so decline still works.
 */
export const ActionApprovalRow = ({
  item,
  showAgent = false,
}: ActionApprovalRowProps) => {
  const { customConnection, slackAccess, contactBlocked, chooseSender } = item;
  if (customConnection) {
    return (
      <CustomConnectionApprovalRow
        item={{ ...item, customConnection }}
        showAgent={showAgent}
      />
    );
  }
  if (slackAccess) {
    return null;
  }
  if (contactBlocked) {
    return <ContactBlockedCard item={{ ...item, contactBlocked }} />;
  }
  if (chooseSender) {
    return <ChooseSenderCard item={{ ...item, chooseSender }} />;
  }
  return <GenericActionApprovalRow item={item} />;
};
