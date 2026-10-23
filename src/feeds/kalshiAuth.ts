// Kalshi API-key request signing (pure helpers; secrets are never logged).
// Signature = base64(sign(timestampMs + "GET" + path)): RSA-PSS/SHA-256 (salt = digest length) for RSA keys, plain Ed25519 for ed25519 keys.
// Timestamp skew window is ~30s, so headers MUST be regenerated on every (re)connect.
import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** Parse a PEM (PKCS#1 or PKCS#8). Accepts literal "\n" sequences and surrounding quotes (typical .env inline form). */
export function parsePrivateKey(pem: string): KeyObject {
  let p = pem.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
  p = p.replace(/\\n/g, "\n").trim() + "\n";
  return createPrivateKey(p);
}

/** Load the key from inline PEM or a file path. Returns null when neither is given; throws (without leaking the key) if unparsable. */
export function loadPrivateKey(o: { pem?: string; path?: string }): KeyObject | null {
  if (o.pem) return parsePrivateKey(o.pem);
  if (o.path) return parsePrivateKey(readFileSync(o.path, "utf8"));
  return null;
}

/** base64 signature of `message` with the key's native Kalshi algorithm. */
export function signMessage(key: KeyObject, message: string): string {
  const buf = Buffer.from(message, "utf8");
  const type = key.asymmetricKeyType;
  if (type === "rsa" || type === "rsa-pss") {
    return sign("sha256", buf, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }).toString("base64");
  }
  if (type === "ed25519") return sign(null, buf, key).toString("base64");
  throw new Error(`unsupported Kalshi key type: ${type}`);
}

/** Handshake headers for a Kalshi request. `path` is the URL path only (e.g. "/trade-api/ws/v2"), no query. */
export function kalshiHeaders(keyId: string, key: KeyObject, path: string, method = "GET", tsMs = Date.now()): Record<string, string> {
  const ts = String(tsMs);
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": signMessage(key, ts + method + path),
  };
}
