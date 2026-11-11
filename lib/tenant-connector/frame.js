'use strict';

// One tenant's connector: the existing nightscout-connect Nightscout source
// driver (CONNECT_SOURCE=nightscout) and the existing nightscout-connect
// Nightscout REST output, joined for one frame at a time (decision
// first-preview-no-push-provider). The vcpool runtime owns the schedule: it
// calls run() only for a tenant that is in this member's slice and eligible
// for connector work, so a suspended tenant gets no source request at all.
//
// The output writes through the tenant's own API (the api role, tenant chosen
// by Host) as the tenant-bound connector subject. nightscout-connect sends
// API-SECRET: sha1(credential); the tenant verifier accepts sha1 of a
// subject's access token as that subject, as a single site does
// (lib/secrets/component.js verifyLegacyCredential). The credential is the
// subject's token, never the tenant's root secret.
//
// Only the source requests use the member's egress proxy. Each response that
// refuses (HTTP 401, 403, 423, 429, 5xx, or no response) is reported to onRefusal
// with its phase, status and code; nothing else about the request (URL,
// headers, body) leaves this module.
const sources = require('nightscout-connect/lib/sources');
const outputs = require('nightscout-connect/lib/outputs');

// 423 is the tenant API refusing a read while the tenant is paused: a
// connector built during a pause cannot read its gap until unpause.
const REFUSED = status => [401, 403, 423, 429].includes(status) || (status >= 500 && status <= 599);
const failure = (code, status) => Object.assign(new Error(code), { code, ...(status === undefined ? {} : { status }) });

// The status of an axios error or of nightscout-connect's sanitized write
// error; never the error itself (axios errors carry request headers).
function statusOf (error) {
  if (!error) return null;
  if (Number.isSafeInteger(error.status)) return error.status;
  if (error.response && Number.isSafeInteger(error.response.status)) return error.response.status;
  return null;
}
function codeOf (error) {
  return error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
}

// An axios stand-in whose create() pins the transport options this module
// owns: proxy (or none), no redirects for the source, the tenant Host header
// for the output, and a refusal hook.
function transport (axios, { proxy, headers, maxRedirects, onError }) {
  return {
    create (options = {}) {
      const instance = axios.create({ ...options, proxy: proxy || false, maxRedirects,
        headers: { ...(options.headers || {}), ...headers }, timeout: 30000 });
      instance.interceptors.response.use(response => response, error => {
        try { onError(statusOf(error), codeOf(error)); } catch { /* reporting never changes the outcome */ }
        return Promise.reject(error);
      });
      return instance;
    }
  };
}

function logger (tenant, log) {
  // nightscout-connect's own messages are fixed strings; they are passed on
  // with the tenant id and nothing else.
  const line = level => (message) => log(level, tenant, typeof message === 'string' ? message.slice(0, 300) : 'connector message');
  return { debug: () => {}, info: line('info'), warn: line('warn'), error: line('error'), log: () => {} };
}

function create ({ tenant, api, host, endpoint, credential, credentialKind, writeCredential, collections, proxy,
  onRefusal = () => {}, log = () => {}, axios = require('axios'), now = Date.now }) {
  if (!(endpoint instanceof URL)) throw new TypeError('A checked source endpoint is required');
  if (typeof credential !== 'string' || !credential || typeof writeCredential !== 'string' || !writeCredential) {
    throw new TypeError('Source and write credentials are required');
  }
  const report = phase => (status, code) => { if (status === null || REFUSED(status)) onRefusal({ phase, status, code }); };
  const source = new URL(endpoint.href);
  let apiSecret = '';
  if (credentialKind === 'token') source.searchParams.set('token', credential);
  else apiSecret = credential;
  const connectLog = logger(tenant, log);
  const driverOf = sources({ kind: 'nightscout' });
  const validated = driverOf.validate({ sourceEndpoint: source.href, sourceApiSecret: apiSecret, sourceCollections: [...collections] });
  if (!validated.ok) throw failure('CONNECTOR_SOURCE_REFUSED');
  const impl = driverOf(validated.config, transport(axios, { proxy, headers: {}, maxRedirects: 0, onError: report('source') }), connectLog);
  const output = outputs({ name: 'nightscout' })({ name: 'nightscout', url: api, apiSecret: writeCredential, logger: connectLog },
    transport(axios, { proxy: null, headers: { Host: host }, maxRedirects: 0, onError: report('write') }));
  let session = null, sessionUntil = 0;

  // One frame: gap from the tenant (its newest stored rows), source session,
  // fetch after the gap, write the batch. Resolves with the counts written.
  async function run () {
    let lastKnown;
    try { lastKnown = await output.gap_for(); } catch (error) { throw failure('CONNECTOR_GAP_FAILED', statusOf(error)); }
    if (!session || now() >= sessionUntil) {
      try {
        session = await impl.sessionFromAuth(await impl.authFromCredentials());
        const ttl = Number.isFinite(session && session.ttl) && session.ttl > 0 ? session.ttl : 3600000;
        // Renew a minute before the source's own expiry, and at most every 8 h as the driver does.
        sessionUntil = now() + Math.max(1000, Math.min(ttl, 28800000) - 60000);
      } catch (error) {
        session = null;
        throw failure('CONNECTOR_SOURCE_AUTH_FAILED', statusOf(error));
      }
    }
    let batch;
    try { batch = impl.transformGlucose(await impl.dataFromSesssion(session, lastKnown)); } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) session = null;
      throw failure('CONNECTOR_SOURCE_FETCH_FAILED', status);
    }
    let bookmark;
    try { bookmark = await output(batch); } catch (error) { throw failure('CONNECTOR_WRITE_FAILED', statusOf(error)); }
    const counts = Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profiles'].map(kind => [kind, (batch[kind] || []).length]));
    let alignTo;
    try { alignTo = impl.align_to_glucose(bookmark); } catch { alignTo = null; }
    return Object.freeze({ counts: Object.freeze(counts), alignTo: Number.isFinite(alignTo) ? alignTo : null });
  }
  return Object.freeze({ tenant, run });
}

module.exports = { create, statusOf, REFUSED };
