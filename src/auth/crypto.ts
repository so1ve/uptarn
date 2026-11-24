const encoder = new TextEncoder();

const sha256Bytes = async (input: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));

export async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256Bytes(input);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function timingSafeEqualText(
  left: string,
  right: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let diff = 0;
  for (const [i, byte] of a.entries()) {
    diff |= byte ^ b[i];
  }

  return diff === 0;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

export function generateRandomToken(prefix: string, byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return `${prefix}_${toBase64Url(bytes)}`;
}
