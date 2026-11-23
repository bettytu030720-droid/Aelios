import { b64url, fromB64url } from "./base64";

async function sealKey(secret: string, context: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode(context), info: encoder.encode("token-seal")
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealSecret(secret: string, context: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv },
    await sealKey(secret, context), new TextEncoder().encode(plain)));
  return `v1.${b64url(iv)}.${b64url(cipher)}`;
}

export async function unsealSecret(secret: string, context: string, sealed: string | null): Promise<string | null> {
  const parts = (sealed || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(parts[1]) },
      await sealKey(secret, context), fromB64url(parts[2]));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}
