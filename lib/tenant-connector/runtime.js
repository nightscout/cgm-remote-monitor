'use strict';

// The vcpool cycle (MT-CONNECTOR-REVERSE). Before each cycle the member reads
// its pool slice (decisions pool-primitive-shared, evaluator-static-partition:
// kind vcpool, tenants hashed by tenant id) and the durable activity state
// (decision activity-is-pause-suspend: paused tenants keep polling, suspended
// tenants get nothing). A tenant outside the slice or not eligible has its
// connector discarded: no source request, no write, no decrypted credential
// kept in memory. The next eligible cycle rebuilds it, and the rebuilt
// connector re-reads its gap from the tenant, so a resumed pull continues from
// what the tenant holds.
//
// Refusals (source or tenant API answering 401/403/429/5xx, or not answering)
// are counted per tenant and per member, logged once per change of
// (phase, status) per tenant, and returned by inspect().
const REFUSAL_LOG_LIMIT = 300;

function create ({ config, member, activity, decrypt, frame = require('./frame'), log = defaultLog, now = Date.now,
  schedule = { setInterval, clearInterval } }) {
  if (!config || !member || !activity || typeof activity.connectorWorkList !== 'function' || typeof decrypt !== 'function') {
    throw new TypeError('vcpool runtime requires configuration, pool member, activity eligibility and decryption');
  }
  const tenants = [...config.tenants.keys()];
  const state = new Map(tenants.map(id => [id, {
    connector: null, nextDue: 0, status: 'idle', code: null, cycles: 0, lastSuccessAt: null,
    pulled: { entries: 0, treatments: 0, devicestatus: 0, profiles: 0 }, refusals: new Map(), lastRefusal: null, logged: null
  }]));
  const memberRefusals = new Map();
  let memberState = { eligible: null, reason: null };
  let running = null, timers = [], closed = false, cycles = 0;

  function refusal (tenant, { phase, status, code }) {
    const row = state.get(tenant);
    const key = phase + ':' + (status === null ? (code || 'NO_RESPONSE') : status);
    row.refusals.set(key, (row.refusals.get(key) || 0) + 1);
    memberRefusals.set(key, (memberRefusals.get(key) || 0) + 1);
    row.lastRefusal = { phase, status, code: code || null, at: new Date(now()).toISOString() };
    if (row.logged !== key) {
      row.logged = key;
      log('warn', tenant, 'upstream refusal ' + key + ' (member ordinal ' + member.configured.ordinal + ')');
    }
  }
  function discard (row) { row.connector = null; }

  async function connectorFor (id) {
    const row = state.get(id);
    if (row.connector) return row.connector;
    const tenant = config.tenants.get(id);
    const read = async ref => (await decrypt(tenant, ref)).toString('utf8');
    // Decrypted values live in this closure only, until the connector is discarded.
    const endpointText = await read(tenant.connector.sourceEndpoint);
    const endpoint = require('./config').sourceEndpoint(endpointText.trim(), config.sources);
    row.connector = frame.create({ tenant: id, api: config.api, host: tenant.host, endpoint,
      credential: (await read(tenant.connector.sourceCredential)).trim(), credentialKind: tenant.connector.sourceCredentialKind,
      writeCredential: (await read(tenant.connector.writeCredential)).trim(), collections: tenant.connector.collections,
      proxy: config.egress.proxy, onRefusal: event => refusal(id, event), log });
    return row.connector;
  }

  async function poll (id) {
    const row = state.get(id);
    try {
      const connector = await connectorFor(id);
      const result = await connector.run();
      for (const [kind, count] of Object.entries(result.counts)) row.pulled[kind] += count;
      row.status = 'polling'; row.code = null; row.lastSuccessAt = new Date(now()).toISOString(); row.logged = null;
      const due = now() + config.pollIntervalMs;
      row.nextDue = result.alignTo && result.alignTo > now() && result.alignTo < due ? result.alignTo : due;
    } catch (error) {
      row.status = 'refused';
      row.code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'CONNECTOR_FAILED';
      if (row.code.startsWith('SECRETS_') || row.code === 'CONNECTOR_SOURCE_REFUSED') {
        refusal(id, { phase: 'setup', status: null, code: row.code });
      }
      // A refused connector is rebuilt next time: credentials are decrypted again
      // and the gap is read again from the tenant.
      discard(row);
      row.nextDue = now() + config.retryMs;
    } finally { row.cycles += 1; }
  }

  async function cycle () {
    if (closed) return;
    if (running) return running;
    running = (async () => {
      cycles += 1;
      const slice = await member.slice();
      if (!slice.eligible) {
        // Fail closed: this member works no tenant until membership agrees again.
        memberState = { eligible: false, reason: slice.reason };
        for (const row of state.values()) { discard(row); row.status = 'member-refused'; row.code = slice.reason; }
        return;
      }
      memberState = { eligible: true, reason: null };
      const mine = tenants.filter(id => slice.includes(id));
      for (const id of tenants) {
        if (!mine.includes(id)) { const row = state.get(id); discard(row); row.status = 'not-in-slice'; row.code = null; }
      }
      const { eligible, skipped } = await activity.connectorWorkList(mine);
      for (const skip of skipped) {
        const row = state.get(skip.tenant);
        if (row.status !== 'skipped' || row.code !== skip.code) log('info', skip.tenant, 'connector skipped: ' + skip.code);
        discard(row); row.status = 'skipped'; row.code = skip.code; row.nextDue = 0;
      }
      // Tenants run one after another: one member's egress is one sequence of requests.
      for (const id of eligible) {
        if (closed) break;
        if (state.get(id).nextDue <= now()) await poll(id);
      }
    })().finally(() => { running = null; });
    return running;
  }

  function start () {
    if (timers.length || closed) return;
    const tick = () => cycle().catch(() => { log('error', null, 'connector cycle failed'); });
    timers.push(schedule.setInterval(tick, config.cycleMs));
    if (member.configured.mode === 'partitioned') {
      const every = Math.max(50, Math.floor(member.configured.leaseMs / 3));
      timers.push(schedule.setInterval(() => member.heartbeat().catch(() => {}), every));
    }
    for (const timer of timers) if (timer && typeof timer.unref === 'function') timer.unref();
    tick();
  }

  async function inspect () {
    const pool = await member.inspect();
    const observed = pool.observed;
    const counts = map => [...map].sort().map(([key, count]) => ({ key, count }));
    return {
      kind: 'vcpool',
      member: { mode: pool.configured.mode, members: pool.configured.mode === 'standalone' ? 1 : observed && Number.isSafeInteger(observed.members) ? observed.members : null, ordinal: pool.configured.ordinal,
        eligible: memberState.eligible, reason: memberState.reason, cycles,
        liveOrdinals: observed && Array.isArray(observed.liveOrdinals) ? [...observed.liveOrdinals] : null,
        conflicts: observed && Array.isArray(observed.conflicts) ? observed.conflicts.length : 0,
        observedReason: observed && observed.reason ? observed.reason : null,
        refusals: counts(memberRefusals) },
      egress: { proxy: !!config.egress.proxy },
      tenants: tenants.map(id => {
        const row = state.get(id);
        return { tenant: id, status: row.status, code: row.code, cycles: row.cycles, lastSuccessAt: row.lastSuccessAt,
          pulled: { ...row.pulled }, refusals: counts(row.refusals), lastRefusal: row.lastRefusal ? { ...row.lastRefusal } : null };
      })
    };
  }

  async function close () {
    if (closed) return;
    closed = true;
    for (const timer of timers) schedule.clearInterval(timer);
    timers = [];
    if (running) await running.catch(() => {});
    for (const row of state.values()) discard(row);
  }
  return Object.freeze({ start, cycle, inspect, close });
}

function defaultLog (level, tenant, message) {
  const line = 'vcpool' + (tenant ? ' tenant ' + tenant : '') + ': ' + String(message).slice(0, REFUSAL_LOG_LIMIT);
  if (level === 'error' || level === 'warn') console.error(line); else console.log(line);
}

module.exports = { create };
