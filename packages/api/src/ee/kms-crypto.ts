import type { CryptoService } from "../lib/crypto-types";

const unsupported = () =>
  new Error(
    "KMS envelope encryption is not supported in this build; secrets are encrypted with SECRET_ENCRYPTION_KEY",
  );

/**
 * KMS envelope encryption is dropped. This stand-in is only ever installed
 * on the cloud edition, which never boots here; it throws rather than
 * silently producing bytes the local AES service could not read back.
 */
export const cryptoService: CryptoService = {
  encrypt: async () => {
    throw unsupported();
  },
  decrypt: async () => {
    throw unsupported();
  },
};
