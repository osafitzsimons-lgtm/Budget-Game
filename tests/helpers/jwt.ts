const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function makeKeys(kid = 'k1') {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { pair, kid, jwks: { keys: [{ kid, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] } };
}

export async function signJwt(keys: Awaited<ReturnType<typeof makeKeys>>, payload: Record<string, unknown>, kid = keys.kid) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

export const TEAM = 'test-team.cloudflareaccess.com';
export const AUD = 'aud-123';
export const EMAIL = 'ollie@example.com';

export function fetcherFor(jwks: unknown): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(jwks), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

export function goodClaims(o: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: now + 3600, nbf: now - 10, iat: now, type: 'app', ...o };
}
