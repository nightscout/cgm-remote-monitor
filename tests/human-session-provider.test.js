'use strict';

const assert = require('node:assert/strict');
const { createProvider, randomProof } = require('../lib/human-session/provider');
const fixture = require('./fixtures/human-oidc-provider');

describe('shared human OIDC provider protocol (synthetic in-process HTTP transport)', function () {
  this.timeout(10000);
  let source, provider;
  beforeEach(async function () {
    source = await fixture();
    provider = await createProvider(source);
  });

  async function flow (overrides = {}) {
    const proof = randomProof();
    const authorizationURL = await provider.begin({ ...proof, ...overrides });
    const url = source.authorize(authorizationURL);
    return { ...proof, url, ...overrides };
  }

  it('exchanges signed code with state/nonce/S256 and returns identity without provider grants', async function () {
    const input = await flow();
    source.state.tokenOverrides.roles = ['root', 'management'];
    const result = await provider.finish(input);
    assert.deepEqual(result, { issuer: source.issuer, subject: 'synthetic-subject',
      authenticatedAt: source.state.authenticationTime, providerSession: 'synthetic-provider-session' });
    assert.ok(source.state.requests.some(request => request.pathname === '/jwks'));
    assert.ok(source.state.requests.every(request => request.redirect === 'manual'));
  });

  it('uses max_age=0 and explicit login for new authentication; silent renewal preserves authentication age', async function () {
    const proof = randomProof();
    const fresh = new URL(await provider.begin(proof));
    assert.equal(fresh.searchParams.get('max_age'), '0');
    assert.equal(fresh.searchParams.get('prompt'), 'login');
    source.state.authenticationTime -= 900;
    const silent = new URL(await provider.begin({ ...proof, renewal: true }));
    assert.equal(silent.searchParams.get('prompt'), 'none');
    assert.equal(silent.searchParams.has('max_age'), false);
    const identity = await provider.finish({ ...proof, url: source.authorize(silent), renewal: true });
    assert.equal(identity.authenticatedAt, source.state.authenticationTime);
  });

  it('accepts a completed fresh authentication round trip and refuses stale authentication for a new login', async function () {
    source.state.authenticationTime -= 5;
    assert.equal((await provider.finish(await flow())).authenticatedAt, source.state.authenticationTime);
    source.state.authenticationTime -= 301;
    await assert.rejects(provider.finish(await flow()), { code: 'OIDC_IDENTITY_REFUSED' });
  });

  for (const [name, mutate] of [
    ['issuer', () => { source.state.tokenOverrides.iss = 'https://foreign.synthetic.invalid'; }],
    ['audience', () => { source.state.tokenOverrides.aud = 'foreign-client'; }],
    ['signature', () => { source.state.foreignSignature = true; }],
    ['nonce', () => { source.state.tokenOverrides.nonce = randomProof().nonce; }],
    ['auth_time presence', () => { source.state.tokenOverrides.auth_time = undefined; }],
    ['future auth_time', () => { source.state.tokenOverrides.auth_time = Math.floor(Date.now() / 1000) + 1000; }],
    ['expired token', () => { source.state.tokenOverrides.exp = Math.floor(Date.now() / 1000) - 1; }]
  ]) {
    it('refuses invalid ' + name + ' in provider response', async function () {
      const input = await flow();
      mutate();
      await assert.rejects(provider.finish(input), { code: 'OIDC_IDENTITY_REFUSED' });
    });
  }

  it('refuses wrong state before token exchange', async function () {
    const input = await flow();
    const before = source.state.requests.filter(r => r.pathname === '/token').length;
    await assert.rejects(provider.finish({ ...input, state: randomProof().state }), { code: 'OIDC_IDENTITY_REFUSED' });
    assert.equal(source.state.requests.filter(r => r.pathname === '/token').length, before);
  });

  it('refuses wrong PKCE verifier and a replayed code', async function () {
    const input = await flow();
    await assert.rejects(provider.finish({ ...input, codeVerifier: randomProof().codeVerifier }), { code: 'OIDC_IDENTITY_REFUSED' });
    const valid = await flow();
    await provider.finish(valid);
    await assert.rejects(provider.finish(valid), { code: 'OIDC_IDENTITY_REFUSED' });
  });

  it('refuses a callback at an unconfigured origin/path without touching provider', async function () {
    const input = await flow();
    const before = source.state.requests.length;
    await assert.rejects(provider.finish({ ...input, url: input.url.replace('nightscout.synthetic.invalid', 'foreign.synthetic.invalid') }),
      { code: 'OIDC_CALLBACK_INVALID' });
    assert.equal(source.state.requests.length, before);
  });

  it('refuses login/renewal proof while provider is unavailable, without cached identity fallback', async function () {
    const first = await flow();
    await provider.finish(first);
    const second = await flow({ renewal: true });
    source.state.offline = true;
    await assert.rejects(provider.finish(second), { code: 'OIDC_PROVIDER_UNAVAILABLE' });
    await assert.rejects(createProvider(source), { code: 'OIDC_PROVIDER_UNAVAILABLE' });
  });

  it('does not allow HTTP outside an explicit lab loopback configuration', async function () {
    await assert.rejects(createProvider({ ...source, issuer: 'http://identity.synthetic.invalid' }), TypeError);
    await assert.rejects(createProvider({ ...source, redirectUri: 'http://nightscout.synthetic.invalid/auth/oidc/callback' }), TypeError);
  });

  it('authenticates signed backchannel logout and returns scoped replay identity for durable consumption', async function () {
    const token = await source.logoutToken();
    const result = await provider.verifyLogout(token);
    assert.equal(result.issuer, source.issuer);
    assert.equal(result.providerSession, 'synthetic-provider-session');
    assert.equal(result.subject, null);
    assert.ok(result.eventId);
    assert.equal(new URL(provider.logoutURL()).origin, source.issuer);
  });

  it('refuses logout wrong issuer/audience/signature/events/nonce/old time and missing session binding', async function () {
    for (const overrides of [
      { iss: 'https://foreign.synthetic.invalid' }, { aud: 'foreign-client' },
      { events: {} }, { nonce: 'forbidden' }, { iat: Math.floor(Date.now() / 1000) - 301 },
      { sid: undefined }, { jti: '' }
    ]) await assert.rejects(provider.verifyLogout(await source.logoutToken(overrides)), { code: 'OIDC_LOGOUT_REFUSED' });
    await assert.rejects(provider.verifyLogout(await source.logoutToken({}, true)), { code: 'OIDC_LOGOUT_REFUSED' });
  });

  it('discloses signal-less provider limitation and refuses invented logout coverage', async function () {
    const noSignal = await fixture({ logoutSignals: false });
    const adapter = await createProvider(noSignal);
    assert.equal(adapter.capabilities.backchannelLogout, false);
    assert.match(adapter.capabilities.limitation, /expiry or provider-backed renewal/);
    await assert.rejects(adapter.verifyLogout(await noSignal.logoutToken()), { code: 'OIDC_LOGOUT_UNSUPPORTED' });
  });
});
