import {
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "./credential-secrets.js";

/**
 * Re-encrypt a v1 ciphertext under a new KEK (key rotation).
 * Old ciphertext remains valid until callers rewrite storage.
 */
export function reencryptCredentialSecret(
  encrypted: string,
  oldKek: string,
  newKek: string,
): string {
  const plain = decryptCredentialSecret(encrypted, oldKek);
  return encryptCredentialSecret(plain, newKek);
}

/**
 * Dual-read decrypt: try current KEK, then previous (during rotation window).
 */
export function decryptCredentialSecretWithFallback(
  encrypted: string,
  currentKek: string,
  previousKek?: string | null,
): string {
  try {
    return decryptCredentialSecret(encrypted, currentKek);
  } catch (error) {
    if (!previousKek) {
      throw error;
    }
    return decryptCredentialSecret(encrypted, previousKek);
  }
}

/** Validate that a restored KEK can decrypt a sample ciphertext. */
export function assertKekCanDecrypt(
  encrypted: string,
  kek: string,
): { ok: true } | { ok: false; code: "missing_key" | "decrypt_failed" } {
  if (!kek) {
    return { ok: false, code: "missing_key" };
  }
  try {
    decryptCredentialSecret(encrypted, kek);
    return { ok: true };
  } catch {
    return { ok: false, code: "decrypt_failed" };
  }
}

/** Produce a sample sealed blob for backup verification (not a real secret). */
export function sealBackupVerificationBlob(kek: string): string {
  return encryptCredentialSecret("quorum-backup-verify", kek);
}
