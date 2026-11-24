// Cryptographic primitives for password hashing (scrypt), AES-256-GCM credential encryption, and token digests.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Ephemeral fallback key when SPACIX_ENCRYPTION_KEY is unset; never hardcoded or written to disk.
const EPHEMERAL_KEY = randomBytes(32);

export function hasConfiguredEncryptionKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SPACIX_ENCRYPTION_KEY?.trim());
}

function deriveEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.SPACIX_ENCRYPTION_KEY?.trim();
  if (!configured) return EPHEMERAL_KEY;
  return createHash("sha256").update(configured, "utf8").digest();
}

export function hashPassword(password: string): string {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!password || !storedHash || !storedHash.startsWith("scrypt$")) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3) return false;
  const [, salt, hex] = parts;
  if (!salt || !hex) return false;
  try {
    const expected = Buffer.from(hex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = deriveEncryptionKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

export function decryptSecret(payload: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!payload || !payload.startsWith("enc:v1:")) return null;
  const parts = payload.split(":");
  if (parts.length !== 5) return null;
  try {
    const iv = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const data = Buffer.from(parts[4], "base64url");
    const key = deriveEncryptionKey(env);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function maskSecretHint(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
