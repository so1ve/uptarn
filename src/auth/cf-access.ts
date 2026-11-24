import { fromBase64Url } from "./crypto.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JWKS_TTL_MS = 10 * 60 * 1000;

interface CachedJwks {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

const jwksCache = new Map<string, CachedJwks>();

async function fetchCfAccessKeys(
  teamDomain: string,
  forceRefresh: boolean,
): Promise<Map<string, CryptoKey>> {
  const cached = jwksCache.get(teamDomain);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`CF Access certs fetch failed (${response.status})`);
  }

  const body = await response.json<{
    keys?: (JsonWebKey & { kid?: string })[];
  }>();
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") {
      continue;
    }
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, cryptoKey);
  }

  jwksCache.set(teamDomain, { fetchedAt: now, keys });

  return keys;
}

export async function verifyCloudflareAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string | string[];
    iss?: string;
    exp?: number;
    nbf?: number;
  };
  try {
    header = JSON.parse(
      decoder.decode(fromBase64Url(headerB64)),
    ) as typeof header;
    payload = JSON.parse(
      decoder.decode(fromBase64Url(payloadB64)),
    ) as typeof payload;
  } catch {
    return false;
  }

  if (header.alg !== "RS256" || !header.kid) {
    return false;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec - 30) {
    return false;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 30) {
    return false;
  }

  if (payload.iss?.replace(/\/+$/, "") !== `https://${teamDomain}`) {
    return false;
  }

  const audList = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (!audList.includes(expectedAud)) {
    return false;
  }

  try {
    let keys = await fetchCfAccessKeys(teamDomain, false);
    let key = keys.get(header.kid);
    if (!key) {
      keys = await fetchCfAccessKeys(teamDomain, true);
      key = keys.get(header.kid);
    }
    if (!key) {
      return false;
    }

    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64Url(sigB64),
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
  } catch {
    return false;
  }
}
