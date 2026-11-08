'use strict';

const { randomBytes, createHash } = require('node:crypto');
const EVENT = 'http://schemas.openid.net/event/backchannel-logout';

// Synthetic provider speaks discovery/code/JWKS HTTP using fetch's Request and
// Response objects. No server listener, Docker provider or real-provider claim.
module.exports = async function fixture ({ issuer = 'https://identity.synthetic.invalid',
  clientId = 'nightscout-synthetic', redirectUri = 'https://nightscout.synthetic.invalid/auth/oidc/callback',
  now = () => Math.floor(Date.now() / 1000), logoutSignals = true } = {}) {
  const jose = await import('jose');
  const keys = await jose.generateKeyPair('RS256');
  const foreign = await jose.generateKeyPair('RS256');
  const publicKey = await jose.exportJWK(keys.publicKey);
  const clientSecret = randomBytes(32).toString('base64url');
  const codes = new Map();
  const state = { offline: false, httpOutageStatus: null, requests: [], tokenOverrides: {}, foreignSignature: false,
    discoveryOverrides: {}, authenticationTime: now() };
  const metadata = {
    issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
    jwks_uri: issuer + '/jwks', end_session_endpoint: issuer + '/logout',
    response_types_supported: ['code'], subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'], backchannel_logout_supported: logoutSignals
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
  async function signed (payload, wrong = false) {
    return new jose.SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
      .sign(wrong ? foreign.privateKey : keys.privateKey);
  }
  async function fetch (input, options = {}) {
    const request = input instanceof Request ? input : new Request(input, options);
    const url = new URL(request.url);
    state.requests.push({ pathname: url.pathname, method: request.method, redirect: request.redirect });
    if (state.offline) throw new TypeError('Synthetic provider unavailable');
    if (state.httpOutageStatus) return json({ error: 'temporarily_unavailable' }, state.httpOutageStatus);
    if (url.origin !== new URL(issuer).origin) return json({ error: 'wrong_origin' }, 404);
    if (url.pathname === '/.well-known/openid-configuration') return json({ ...metadata, ...state.discoveryOverrides });
    if (url.pathname === '/jwks') return json({ keys: [{ ...publicKey, alg: 'RS256', use: 'sig', kid: 'synthetic-key' }] });
    if (url.pathname === '/token' && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      if (body.get('client_id') !== clientId || body.get('client_secret') !== clientSecret ||
          body.get('grant_type') !== 'authorization_code') return json({ error: 'invalid_client' }, 401);
      const code = codes.get(body.get('code'));
      codes.delete(body.get('code'));
      const challenge = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
      if (!code || code.challenge !== challenge || body.get('redirect_uri') !== redirectUri) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const claims = { iss: issuer, sub: code.subject, aud: clientId, iat: now(), exp: now() + 600,
        auth_time: state.authenticationTime, sid: code.providerSession, nonce: code.nonce, ...state.tokenOverrides };
      return json({ access_token: randomBytes(32).toString('base64url'), token_type: 'Bearer', expires_in: 600,
        id_token: await signed(claims, state.foreignSignature) });
    }
    return json({ error: 'not_found' }, 404);
  }
  return {
    issuer, clientId, clientSecret, redirectUri, fetch, state,
    authorize (authorizationURL, { subject = 'synthetic-subject', providerSession = 'synthetic-provider-session' } = {}) {
      if (state.offline) throw new TypeError('Synthetic provider unavailable');
      const url = new URL(authorizationURL);
      if (url.origin !== new URL(issuer).origin || url.pathname !== '/authorize' ||
          url.searchParams.get('client_id') !== clientId || url.searchParams.get('redirect_uri') !== redirectUri ||
          url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('response_type') !== 'code') {
        throw new Error('Synthetic authorization request refused');
      }
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { subject, providerSession, challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce') });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('iss', issuer);
      return callback.href;
    },
    logoutToken (overrides = {}, wrongSignature = false) {
      return signed({ iss: issuer, aud: clientId, iat: now(), jti: randomBytes(32).toString('base64url'),
        events: { [EVENT]: {} }, sid: 'synthetic-provider-session', ...overrides }, wrongSignature);
    }
  };
};
