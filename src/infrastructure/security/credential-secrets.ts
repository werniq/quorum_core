import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const PREFIX = "v1";

function deriveKey(kek: string): Buffer {
  return scryptSync(kek, "quorum-credential-kek", 32);
}

/** Encrypt a per-workflow HMAC secret for durable storage. */
export function encryptCredentialSecret(
  plainSecret: string,
  kek: string,
): string {
  const key = deriveKey(kek);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainSecret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptCredentialSecret(
  encrypted: string,
  kek: string,
): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Unsupported credential secret encoding");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(kek);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64!, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64!, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64!, "base64url")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
