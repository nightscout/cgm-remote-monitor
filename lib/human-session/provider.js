'use strict';

const { randomBytes } = require('node:crypto');
const proofValue = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const fail = code => Object.assign(new Error(code), { code });
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

function randomProof () {
  return Object.freeze({ state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'), codeVerifier: randomBytes(32).toString('base64url') });
}

function trustedURL (value, allowInsecureLoopback) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Explicit absolute OIDC URL required'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))) {
    throw new TypeError('OIDC requires HTTPS; explicit loopback HTTP is lab-only');
  }
  return url;
}

// Only deployment configuration reaches discovery. Provider claims authenticate
// an issuer/subject; local authority and all session mutation belong elsewhere.
async function createProvider ({ issuer, clientId, clientSecret, redirectUri,
  signingAlgorithm = 'RS256', allowInsecureLoopback = false, timeoutSeconds = 5,
  fetch: configuredFetch = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const server = trustedURL(issuer, allowInsecureLoopback);
  const callback = trustedURL(redirectUri, allowInsecureLoopback);
  if (server.search || callback.search || typeof clientId !== 'string' || !clientId || clientId.length > 512 ||
      typeof clientSecret !== 'string' || !clientSecret || clientSecret.length > 4096 ||
      !['RS256', 'PS256', 'ES256', 'EdDSA'].includes(signingAlgorithm) ||
      !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30 ||
      typeof configuredFetch !== 'function' || typeof now !== 'function') {
    throw new TypeError('Explicit bounded OIDC configuration required');
  }
  const [client, jose] = await Promise.all([import('openid-client'), import('jose')]);
  // Manual redirects prevent a trusted endpoint forwarding a client secret to
  // another location. The library's timeout also bounds JWKS and token requests.
  const transport = (url, options = {}) => configuredFetch(url, { ...options, redirect: 'manual' });
  const execute = [client.enableNonRepudiationChecks];
  if (allowInsecureLoopback) execute.push(client.allowInsecureRequests);
  let config;
  try {
    config = await client.discovery(server, clientId,
      { id_token_signed_response_alg: signingAlgorithm, [client.clockTolerance]: 0 }, client.ClientSecretPost(clientSecret),
      { [client.customFetch]: transport, timeout: timeoutSeconds, execute });
  } catch { throw fail('OIDC_PROVIDER_UNAVAILABLE'); }
  const metadata = config.serverMetadata();
  if (metadata.issuer !== issuer || !metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
    throw fail('OIDC_PROVIDER_CONFIGURATION');
  }
  for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint']) {
    if (metadata[name]) trustedURL(metadata[name], allowInsecureLoopback);
  }
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) {
    throw fail('OIDC_PROVIDER_PKCE_UNSUPPORTED');
  }
  const jwks = jose.createRemoteJWKSet(new URL(metadata.jwks_uri), {
    timeoutDuration: timeoutSeconds * 1000, [jose.customFetch]: transport
  });

  function proof (input) {
    if (!input || ![input.state, input.nonce, input.codeVerifier].every(proofValue)) throw fail('OIDC_PROOF_INVALID');
  }

  return Object.freeze({
    issuer,
    capabilities: Object.freeze({ providerLogout: !!metadata.end_session_endpoint,
      backchannelLogout: metadata.backchannel_logout_supported === true,
      limitation: metadata.backchannel_logout_supported === true ? null :
        'Provider revocation is visible at expiry or provider-backed renewal; no provider logout signal is advertised.' }),
    async begin (input) {
      proof(input);
      const parameters = { redirect_uri: callback.href, scope: 'openid', response_type: 'code',
        state: input.state, nonce: input.nonce, code_challenge_method: 'S256',
        code_challenge: await client.calculatePKCECodeChallenge(input.codeVerifier) };
      if (input.renewal) parameters.prompt = 'none';
      else { parameters.max_age = '0'; parameters.prompt = 'login'; }
      return client.buildAuthorizationUrl(config, parameters).href;
    },
    async finish (input) {
      proof(input);
      let current;
      try { current = new URL(input.url); } catch { throw fail('OIDC_CALLBACK_INVALID'); }
      if (current.origin !== callback.origin || current.pathname !== callback.pathname || current.hash || current.username || current.password) {
        throw fail('OIDC_CALLBACK_INVALID');
      }
      let tokens;
      try {
        tokens = await client.authorizationCodeGrant(config, current, {
          expectedState: input.state, expectedNonce: input.nonce, pkceCodeVerifier: input.codeVerifier,
          // Request actual reauthentication, then allow its network round trip
          // within the adopted sensitive-action freshness ceiling. Zero clock
          // tolerance still makes token expiry exact, with no offline grace.
          idTokenExpected: true, ...(input.renewal ? {} : { maxAge: 300 })
        });
      } catch (error) {
        const unavailable = ['OAUTH_TIMEOUT', 'OAUTH_REQUEST_FAILED', 'ERR_OPERATION_TIMEOUT'].includes(error.code) ||
          error instanceof TypeError || error.cause instanceof TypeError || error.name === 'TimeoutError';
        throw fail(unavailable ? 'OIDC_PROVIDER_UNAVAILABLE' : 'OIDC_IDENTITY_REFUSED');
      }
      const claims = tokens.claims();
      if (!claims || claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 1024 ||
          !Number.isSafeInteger(claims.auth_time) || claims.auth_time < 0 || claims.auth_time > now() ||
          (claims.sid !== undefined && (typeof claims.sid !== 'string' || !claims.sid || claims.sid.length > 1024))) {
        throw fail('OIDC_IDENTITY_REFUSED');
      }
      return Object.freeze({ issuer: claims.iss, subject: claims.sub,
        authenticatedAt: claims.auth_time, providerSession: claims.sid || null });
    },
    logoutURL () {
      if (!metadata.end_session_endpoint) return null;
      return client.buildEndSessionUrl(config, { client_id: clientId }).href;
    },
    async verifyLogout (token) {
      if (metadata.backchannel_logout_supported !== true) throw fail('OIDC_LOGOUT_UNSUPPORTED');
      if (typeof token !== 'string' || token.length > 8192) throw fail('OIDC_LOGOUT_REFUSED');
      let payload;
      try {
        ({ payload } = await jose.jwtVerify(token, jwks, {
          issuer, audience: clientId, algorithms: [signingAlgorithm],
          requiredClaims: ['iss', 'aud', 'iat', 'jti', 'events'],
          currentDate: new Date(now() * 1000), clockTolerance: 0
        }));
      } catch { throw fail('OIDC_LOGOUT_REFUSED'); }
      if (!Number.isSafeInteger(payload.iat) || payload.iat > now() || payload.iat < now() - 300 ||
          typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > 1024 ||
          Object.hasOwn(payload, 'nonce') || !payload.events || typeof payload.events !== 'object' ||
          Array.isArray(payload.events) || Object.keys(payload.events).length !== 1 ||
          !Object.hasOwn(payload.events, LOGOUT_EVENT) || !payload.events[LOGOUT_EVENT] ||
          typeof payload.events[LOGOUT_EVENT] !== 'object' || Array.isArray(payload.events[LOGOUT_EVENT]) ||
          Object.keys(payload.events[LOGOUT_EVENT]).length ||
          ![payload.sid, payload.sub].some(value => typeof value === 'string' && value.length > 0 && value.length <= 1024) ||
          [payload.sid, payload.sub].some(value => value !== undefined &&
            (typeof value !== 'string' || !value || value.length > 1024))) throw fail('OIDC_LOGOUT_REFUSED');
      // The session store must consume (issuer,jti) once durably and invalidate
      // only matching mapped provider sessions in the same transaction.
      return Object.freeze({ issuer, eventId: payload.jti, issuedAt: payload.iat,
        providerSession: payload.sid || null, subject: payload.sub || null });
    }
  });
}

module.exports = { createProvider, randomProof };
