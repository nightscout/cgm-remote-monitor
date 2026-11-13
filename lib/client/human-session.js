'use strict';

const shiro = require('shiro-trie');
const PREFIX = '/api/v2/oidc';

// The browser never reads the HttpOnly credential. Identity-provider claims are
// not permissions: this module consumes only the current local /session result.
module.exports = function humanSession ({ client, request, navigate, changed = () => {}, advertised = true }) {
  if (!client || typeof request !== 'function' || typeof navigate !== 'function') throw new TypeError('Human browser session dependencies required');
  const state = { discovered: false, enabled: false, active: false, credentialPresent: false,
    uncertain: false, unavailable: false, csrf: null, session: null, error: null };
  let pending;
  function notify () { changed(state); }
  function failure (code) { return Object.assign(new Error(code), { code }); }
  function clearAuthorization () {
    if (client.authorized?.human) client.authorized = null;
    state.active = false; state.session = null;
  }
  function groupsValid (groups) {
    return Array.isArray(groups) && groups.length <= 256 && groups.every(group => Array.isArray(group) &&
      group.length <= 256 && group.every(permission => typeof permission === 'string' && permission.length > 0 && permission.length <= 512));
  }
  async function probe () {
    try {
      const result = await request({ method: 'GET', url: PREFIX + '/session', headers: {} });
      state.discovered = true;
      const body = result.body || {};
      if (result.status === 404 || result.status === 401 && body.enabled !== true && !String(body.error || '').startsWith('HUMAN_')) {
        state.enabled = false; state.credentialPresent = false; state.unavailable = false; state.csrf = null;
        state.error = state.uncertain ? 'LOCAL_REVOCATION_UNCONFIRMED' : null;
        clearAuthorization(); notify(); return state;
      }
      if (body.enabled !== true) throw failure('HUMAN_SESSION_UNAVAILABLE');
      state.enabled = true;
      state.credentialPresent = body.credentialPresent === true;
      state.csrf = typeof body.csrf === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.csrf) ? body.csrf : null;
      state.unavailable = result.status >= 500;
      if (result.status !== 200) {
        clearAuthorization();
        state.error = state.uncertain ? 'LOCAL_REVOCATION_UNCONFIRMED' : state.credentialPresent
          ? state.unavailable ? 'HUMAN_SESSION_UNAVAILABLE' : 'HUMAN_SESSION_REFUSED' : null;
        if (![401, 403, 503].includes(result.status)) throw failure('HUMAN_SESSION_UNAVAILABLE');
        notify(); return state;
      }
      if (!state.credentialPresent || !body.session || body.session.purpose !== 'data' ||
          typeof body.session.subject !== 'string' || !groupsValid(body.permissionGroups)) throw failure('HUMAN_SESSION_UNAVAILABLE');
      const tries = body.permissionGroups.map(group => { const trie = shiro.new(); trie.add(group); return trie; });
      client.authorized = { human: true, sub: body.session.subject, permissionGroups: body.permissionGroups,
        shiros: tries, check: permission => tries.some(trie => trie.check(permission)) };
      state.session = body.session; state.active = true; state.unavailable = false;
      state.error = state.uncertain ? 'LOCAL_REVOCATION_UNCONFIRMED' : null;
      notify(); return state;
    } catch {
      state.discovered = true; state.unavailable = true;
      state.error = state.uncertain ? 'LOCAL_REVOCATION_UNCONFIRMED' : 'HUMAN_SESSION_UNAVAILABLE';
      clearAuthorization(); notify(); return state;
    }
  }
  async function start (renewal) {
    if (!state.discovered) await prepare();
    if (!state.enabled || renewal && !state.credentialPresent) throw failure('HUMAN_SESSION_ABSENT');
    const response = await request({ method: 'POST', url: PREFIX + (renewal ? '/renew' : '/login'),
      headers: renewal && state.csrf ? { 'x-ns-csrf': state.csrf } : {},
      body: { purpose: 'data', transport: 'cookie' } });
    if (response.status !== 200 || typeof response.body?.location !== 'string') throw failure(response.body?.error || 'HUMAN_SESSION_UNAVAILABLE');
    const location = new URL(response.body.location);
    if (location.protocol !== 'https:' || location.username || location.password) throw failure('HUMAN_PROVIDER_LOCATION_REFUSED');
    navigate(location.href);
  }
  function prepare () {
    if (state.discovered) return Promise.resolve(state);
    if (!pending) pending = probe().finally(() => { pending = null; });
    return pending;
  }
  return {
    state, prepare, probe, advertised: advertised === true,
    suppressesLegacy: () => state.active || state.credentialPresent || state.uncertain || state.unavailable,
    login: () => start(false), renew: () => start(true),
    async logout () {
      if (!state.csrf && state.credentialPresent) await probe();
      if (state.uncertain && !state.credentialPresent) throw failure('LOCAL_REVOCATION_UNCONFIRMED');
      const response = await request({ method: 'POST', url: PREFIX + '/logout',
        headers: state.csrf ? { 'x-ns-csrf': state.csrf } : {}, body: { purpose: 'data' } });
      if (response.status === 503 && response.body?.error === 'LOCAL_REVOCATION_UNCONFIRMED') {
        clearAuthorization(); state.uncertain = true; state.error = 'LOCAL_REVOCATION_UNCONFIRMED'; notify();
        throw failure('LOCAL_REVOCATION_UNCONFIRMED');
      }
      if (response.status !== 200 || !['revoked', 'absent'].includes(response.body?.local)) throw failure(response.body?.error || 'HUMAN_SESSION_UNAVAILABLE');
      clearAuthorization(); state.credentialPresent = false; state.csrf = null; state.error = null; notify();
      return response.body;
    },
    finishLogout (result) {
      if (result.local !== 'revoked' || !result.providerLogout) return false;
      try {
        if (state.active || state.credentialPresent || state.uncertain || typeof result.providerLogout !== 'string') throw new Error();
        const location = new URL(result.providerLogout);
        if (location.protocol !== 'https:' || location.username || location.password) throw new Error();
        // The server returns only its configured RP logout endpoint after the
        // local commit/cookie clear. The provider owns any confirmation or
        // broader provider-session effects; no all-session NS action is added.
        navigate(location.href);
        return true;
      } catch {
        throw failure('HUMAN_PROVIDER_LOGOUT_FAILED');
      }
    },
    report (error) { state.error = error?.code || 'HUMAN_SESSION_UNAVAILABLE'; notify(); },
    message () {
      if (state.uncertain || state.error === 'LOCAL_REVOCATION_UNCONFIRMED') return 'The browser credential was cleared, but Nightscout could not confirm session revocation. Other copies may still work.';
      if (state.error === 'HUMAN_PROVIDER_LOGOUT_FAILED') return 'This Nightscout session was revoked, but provider sign-out could not be opened.';
      if (state.unavailable || state.error === 'HUMAN_SESSION_UNAVAILABLE') return 'Nightscout could not verify this sign-in. Retry when the service is available.';
      if (state.error) return 'This Nightscout sign-in could not be used. Renew it, sign in again, or sign out.';
      return '';
    }
  };
};
