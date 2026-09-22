'use strict';

// Protocol discovery/PKCE adapted from nightscout-connect PR #54 and
// nightscout/carelink-bridge. See docs/carelink-native.md for attribution.
const crypto = require('node:crypto');
const { request, providerUrl } = require('./http');
const ConnectError = require('../../errors');
const REDIRECT = 'com.medtronic.carepartner:/sso';

function createAuth(http = request) {
  let discovery;
  async function discover() {
    if (!discovery || discovery.expires < Date.now()) {
      const data = await http('https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/3.6', { operation: 'discovery' });
      if (!Array.isArray(data.CP) || !Array.isArray(data.supportedCountries)) throw new ConnectError('provider_configuration', 502);
      discovery = { data, expires: Date.now() + 3600000 };
    }
    return discovery.data;
  }
  async function countries() {
    const d = await discover();
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return d.supportedCountries.flatMap(item => Object.values(item))
      .filter(c => /^[A-Z]{2}$/.test(c.isoCode) && ['US', 'EU'].includes(c.region))
      .map(c => ({ code: c.isoCode, name: names.of(c.isoCode) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async function begin(country) {
    const d = await discover();
    const c = d.supportedCountries.flatMap(item => Object.values(item)).find(c => c.isoCode === country);
    if (!c || !['US', 'EU'].includes(c.region)) throw new ConnectError('invalid_country');
    const cp = d.CP.find(item => item.region.toUpperCase() === c.region);
    if (!cp) throw new ConnectError('provider_configuration', 502);
    const config = await http(providerUrl(cp[cp.UseSSOConfiguration || 'Auth0SSOConfiguration']).href, { operation: 'login_configuration' });
    const origin = providerUrl('https://' + config.server.hostname).origin;
    if (config.client.redirect_uri !== REDIRECT || (config.server.port && config.server.port !== 443) || config.server.prefix) {
      throw new ConnectError('provider_configuration', 502);
    }
    function endpoint(path) {
      const url = providerUrl(new URL(path, origin).href);
      if (url.origin !== origin) throw new ConnectError('provider_configuration', 502);
      return url.href;
    }
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    const url = new URL(endpoint(config.system_endpoints.authorization_endpoint_path));
    url.search = new URLSearchParams({
      client_id: config.client.client_id, response_type: 'code', scope: config.client.scope,
      audience: config.client.audience, redirect_uri: REDIRECT,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state, 'ext-country': country, ui_locales: 'en'
    }).toString();
    return { country, region: c.region.toLowerCase(), verifier, state, url: url.href,
      clientId: config.client.client_id, tokenUrl: endpoint(config.system_endpoints.token_endpoint_path) };
  }
  async function tokens(config, params, previous) {
    const body = new URLSearchParams({ client_id: config.clientId, ...params }).toString();
    const data = await http(config.tokenUrl, { method: 'POST', body, operation: previous ? 'token_refresh' : 'token_exchange',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (typeof data.access_token !== 'string' || !(data.refresh_token || previous)) throw new ConnectError('provider_configuration', 502);
    const seconds = Number(data.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new ConnectError('provider_configuration', 502);
    return { accessToken: data.access_token, refreshToken: data.refresh_token || previous,
      expiresAt: Date.now() + seconds * 1000, clientId: config.clientId, tokenUrl: config.tokenUrl };
  }
  return { countries, begin,
    exchange: (transaction, code) => tokens(transaction, { grant_type: 'authorization_code', code,
      code_verifier: transaction.verifier, redirect_uri: REDIRECT }),
    refresh: token => tokens(token, { grant_type: 'refresh_token', refresh_token: token.refreshToken }, token.refreshToken)
  };
}

function capture(value, state) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== 'com.medtronic.carepartner:' || url.host || url.pathname !== '/sso' || url.hash) return null;
  const states = url.searchParams.getAll('state');
  if (states.length !== 1 || Buffer.byteLength(states[0]) !== Buffer.byteLength(state) ||
    !crypto.timingSafeEqual(Buffer.from(states[0]), Buffer.from(state))) throw new ConnectError('invalid_callback');
  const codes = url.searchParams.getAll('code');
  if (url.searchParams.has('error')) throw new ConnectError('login_rejected');
  if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) throw new ConnectError('invalid_callback');
  return codes[0];
}
module.exports = { createAuth, capture, REDIRECT };
