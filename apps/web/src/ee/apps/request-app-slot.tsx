export interface RequestAppSlotProps {
  requestOpen?: boolean;
  onRequestOpenChange?: (open: boolean) => void;
  initialName?: string;
  initialUrl?: string;
}

/**
 * The cloud "Request an app" dialog (in-app form + Resend email + Discord
 * ping) is cloud-only and unreachable here — `lib/components/request-app-slot.tsx`
 * only renders this arm when `IS_CLOUD`, which is permanently false in this
 * onprem-only fork. Null stand-in; the free `LocalRequestAppSlot` (a GitHub
 * issue link) is what actually renders.
 */
export const RequestAppSlot = ({}: RequestAppSlotProps) => null;
