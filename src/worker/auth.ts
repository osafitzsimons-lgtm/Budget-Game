// Verifies the Cloudflare Access JWT on every /api request. Fails closed.

export interface AuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  ALLOWED_EMAIL?: string;
  LOCAL_DEV?: string;
}

export type AuthResult = { ok: true; email: string } | { ok: false; status: number; error: string };

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

let jwksCache: { team: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
const JWKS_TTL = 60 * 60 * 1000;

export function _resetJwksCache() {
  jwksCache = null;
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function normaliseTeam(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${d}`;
}

async function getKeys(team: string, forceRefresh: boolean, fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh && jwksCache && jwksCache.team === team && Date.now() - jwksCache.fetchedAt < JWKS_TTL) return jwksCache.keys;
  const res = await fetcher(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (k.kty !== 'RSA' || !k.kid) continue;
    keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  jwksCache = { team, keys, fetchedAt: Date.now() };
  return keys;
}

export async function verifyAccess(req: Request, env: AuthEnv, fetcher: typeof fetch = fetch): Promise<AuthResult> {
  const url = new URL(req.url);
  // Local development only: needs LOCAL_DEV=true (from .dev.vars, never deployed) AND a localhost URL.
  if (env.LOCAL_DEV === 'true' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return { ok: true, email: 'local-dev@localhost' };
  }

  const teamRaw = env.TEAM_DOMAIN?.trim();
  const audRaw = env.POLICY_AUD?.trim();
  const allowed = env.ALLOWED_EMAIL?.trim().toLowerCase();
  if (!teamRaw || !audRaw || !allowed) {
    return { ok: false, status: 503, error: 'Server is missing TEAM_DOMAIN, POLICY_AUD or ALLOWED_EMAIL, so all requests are refused. See SETUP.md step 2.' };
  }
  const team = normaliseTeam(teamRaw);
  const auds = audRaw.split(',').map((a) => a.trim()).filter(Boolean);

  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { ok: false, status: 401, error: 'Missing Cloudflare Access token.' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, error: 'Malformed Access token.' };

  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string; type?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return { ok: false, status: 401, error: 'Malformed Access token.' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, status: 401, error: 'Unsupported Access token.' };

  let keys: Map<string, CryptoKey>;
  try {
    keys = await getKeys(team, false, fetcher);
    if (!keys.has(header.kid)) keys = await getKeys(team, true, fetcher); // keys rotate
  } catch {
    return { ok: false, status: 503, error: 'Could not fetch Cloudflare Access keys.' };
  }
  const key = keys.get(header.kid);
  if (!key) return { ok: false, status: 401, error: 'Unknown Access signing key.' };

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return { ok: false, status: 401, error: 'Invalid Access token signature.' };

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== team) return { ok: false, status: 401, error: 'Access token from the wrong team.' };
  const tokenAuds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!tokenAuds.some((a) => auds.includes(a))) return { ok: false, status: 401, error: 'Access token for a different application.' };
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return { ok: false, status: 401, error: 'Access token expired. Reload the page.' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return { ok: false, status: 401, error: 'Access token not valid yet.' };
  if (!payload.email || payload.email.trim().toLowerCase() !== allowed) return { ok: false, status: 403, error: 'This account is not allowed.' };
  return { ok: true, email: payload.email };
}
