import { describe, expect, test } from "bun:test";
import { constants, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { kalshiHeaders, loadPrivateKey, parsePrivateKey, signMessage } from "../src/feeds/kalshiAuth.ts";

const MSG = "1703123456789GET/trade-api/ws/v2";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ed = generateKeyPairSync("ed25519");
const verifyPss = (sig: string, salt: number, msg = MSG) =>
  verify("sha256", Buffer.from(msg), { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: salt }, Buffer.from(sig, "base64"));

describe("RSA-PSS", () => {
  const sig = signMessage(rsa.privateKey, MSG);
  test("256-byte signature, verifies with salt length 32", () => {
    expect(Buffer.from(sig, "base64").length).toBe(256);
    expect(verifyPss(sig, 32)).toBe(true);
  });
  test("salt length 0 fails", () => expect(verifyPss(sig, 0)).toBe(false));
  test("tampered message fails", () => expect(verifyPss(sig, 32, MSG + "x")).toBe(false));
  test("tampered signature fails", () => {
    const b = Buffer.from(sig, "base64"); b[10] ^= 0xff;
    expect(verifyPss(b.toString("base64"), 32)).toBe(false);
  });
});

describe("Ed25519", () => {
  const sig = signMessage(ed.privateKey, MSG);
  test("64-byte deterministic signature that verifies", () => {
    expect(Buffer.from(sig, "base64").length).toBe(64);
    expect(signMessage(ed.privateKey, MSG)).toBe(sig);
    expect(verify(null, Buffer.from(MSG), ed.publicKey, Buffer.from(sig, "base64"))).toBe(true);
    expect(verify(null, Buffer.from(MSG + "x"), ed.publicKey, Buffer.from(sig, "base64"))).toBe(false);
  });
});

describe("headers", () => {
  test("carry the same timestamp that was signed", () => {
    const h = kalshiHeaders("key-id", rsa.privateKey, "/trade-api/ws/v2", "GET", 1703123456789);
    expect(h["KALSHI-ACCESS-KEY"]).toBe("key-id");
    expect(h["KALSHI-ACCESS-TIMESTAMP"]).toBe("1703123456789");
    expect(verifyPss(h["KALSHI-ACCESS-SIGNATURE"]!, 32)).toBe(true);
  });
  test("ed25519 headers", () => {
    const h = kalshiHeaders("k", ed.privateKey, "/trade-api/ws/v2", "GET", 1703123456789);
    expect(verify(null, Buffer.from(MSG), ed.publicKey, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"]!, "base64"))).toBe(true);
  });
});

describe("PEM parsing", () => {
  test("PKCS#8, PKCS#1, literal \\n and quotes", () => {
    const p8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const p1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    expect(p1).toContain("BEGIN RSA PRIVATE KEY");
    for (const pem of [p8, p1, p8.replace(/\n/g, "\\n"), `"${p1.replace(/\n/g, "\\n")}"`]) {
      const k = parsePrivateKey(pem);
      expect(k.asymmetricKeyType).toBe("rsa");
      expect(createPublicKey(k).export({ type: "spki", format: "der" })).toEqual(rsa.publicKey.export({ type: "spki", format: "der" }));
    }
    expect(parsePrivateKey(ed.privateKey.export({ type: "pkcs8", format: "pem" }) as string).asymmetricKeyType).toBe("ed25519");
  });
  test("loadPrivateKey returns null without input and throws on garbage without echoing it", () => {
    expect(loadPrivateKey({})).toBeNull();
    expect(() => loadPrivateKey({ pem: "SECRETGARBAGE" })).toThrow();
    try { loadPrivateKey({ pem: "SECRETGARBAGE" }); } catch (e) { expect(String((e as Error).message)).not.toContain("SECRETGARBAGE"); }
  });
});
