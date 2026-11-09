import { beforeEach, describe, expect, it } from 'vitest';
import { _resetJwksCache, verifyAccess } from '../src/worker/auth';
import { AUD, EMAIL, fetcherFor, goodClaims, makeKeys, signJwt, TEAM } from './helpers/jwt';

const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAIL: EMAIL };
const req = (token?: string, url = 'https://budget-guy.example.workers.dev/api/state') => new Request(url, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

describe('Cloudflare Access JWT verification', async () => {
  const keys = await makeKeys();
  const other = await makeKeys('k1');
  beforeEach(() => _resetJwksCache());

  it('accepts a valid token for the allowed email', async () => {
    const r = await verifyAccess(req(await signJwt(keys, goodClaims())), env, fetcherFor(keys.jwks));
    expect(r).toEqual({ ok: true, email: EMAIL });
  });
  it('accepts TEAM_DOMAIN written with https:// and email in any case', async () => {
    const r = await verifyAccess(req(await signJwt(keys, goodClaims({ email: 'Ollie@Example.com' }))), { ...env, TEAM_DOMAIN: `https://${TEAM}/` }, fetcherFor(keys.jwks));
    expect(r.ok).toBe(true);
  });
  it('fails closed when any config is missing', async () => {
    const t = await signJwt(keys, goodClaims());
    for (const k of ['TEAM_DOMAIN', 'POLICY_AUD', 'ALLOWED_EMAIL'] as const) {
      const r = await verifyAccess(req(t), { ...env, [k]: '' }, fetcherFor(keys.jwks));
      expect(r).toMatchObject({ ok: false, status: 503 });
    }
  });
  it('rejects missing, malformed, forged, expired and wrong-audience tokens', async () => {
    const f = fetcherFor(keys.jwks);
    expect((await verifyAccess(req(), env, f)).ok).toBe(false);
    expect((await verifyAccess(req('abc.def'), env, f)).ok).toBe(false);
    expect((await verifyAccess(req(await signJwt(other, goodClaims())), env, f)).ok).toBe(false); // signed by another key
    expect((await verifyAccess(req(await signJwt(keys, goodClaims({ exp: 1000 }))), env, f)).ok).toBe(false);
    expect((await verifyAccess(req(await signJwt(keys, goodClaims({ aud: ['other'] }))), env, f)).ok).toBe(false);
    expect((await verifyAccess(req(await signJwt(keys, goodClaims({ iss: 'https://evil.cloudflareaccess.com' }))), env, f)).ok).toBe(false);
    expect((await verifyAccess(req(await signJwt(keys, goodClaims({ nbf: Math.floor(Date.now() / 1000) + 600 }))), env, f)).ok).toBe(false);
  });
  it('rejects a different email (403)', async () => {
    const r = await verifyAccess(req(await signJwt(keys, goodClaims({ email: 'someone@example.com' }))), env, fetcherFor(keys.jwks));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects alg=none style tokens', async () => {
    const t = await signJwt(keys, goodClaims());
    const [, p, s] = t.split('.');
    const h = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    expect((await verifyAccess(req(`${h}.${p}.${s}`), env, fetcherFor(keys.jwks))).ok).toBe(false);
  });
  it('local bypass needs LOCAL_DEV=true AND a localhost URL', async () => {
    expect((await verifyAccess(req(undefined, 'http://localhost:8787/api/state'), { LOCAL_DEV: 'true' })).ok).toBe(true);
    expect((await verifyAccess(req(undefined, 'https://budget-guy.x.workers.dev/api/state'), { LOCAL_DEV: 'true' })).ok).toBe(false);
    expect((await verifyAccess(req(undefined, 'http://localhost:8787/api/state'), {})).ok).toBe(false);
  });
});
