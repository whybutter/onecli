import type { SshCaSigner } from "../../providers/types";

/**
 * The KMS-backed SSH certificate authority is dropped. `null` keeps the SSH
 * front door dark on the (unreachable) cloud arm; self-host signs in-process
 * from `SSH_CA_PRIVATE_KEY` through the free provider default.
 */
export const kmsSshCa: SshCaSigner | null = null;
