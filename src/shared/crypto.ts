import crypto from "node:crypto";
import { env } from "./env.js";

function key(): Buffer {
  const raw = env("SECRET_ENCRYPTION_KEY");
  let out: Buffer;
  try {
    out = Buffer.from(raw, "base64");
  } catch {
    throw new Error("SECRET_ENCRYPTION_KEY must be base64");
  }
  if (out.length !== 32) throw new Error("SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return out;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const data = Buffer.from(payload, "base64");
  if (data.length < 29) throw new Error("Invalid encrypted secret");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function timingSafeHexEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
