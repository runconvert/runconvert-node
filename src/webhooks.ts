import { createHmac, timingSafeEqual } from "node:crypto";

import type { WebhookEvent } from "./types.js";

/**
 * Checks the `X-RunConvert-Signature` header of a webhook delivery: `sha256=` followed by
 * the hex HMAC-SHA256 of the **raw** request body, keyed with the endpoint's secret.
 * Pass the body exactly as received (string or Buffer), before any JSON parsing.
 */
export function verifySignature(rawBody: string | Uint8Array, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const given = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

/**
 * Verifies the signature, then parses the event. Throws if the signature is wrong,
 * so an unverified payload is never used.
 */
export function constructEvent(rawBody: string | Uint8Array, signature: string | null | undefined, secret: string): WebhookEvent {
  if (!verifySignature(rawBody, signature, secret)) throw new Error("Invalid RunConvert webhook signature");
  const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
  return JSON.parse(text) as WebhookEvent;
}
