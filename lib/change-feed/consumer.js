'use strict';

const connectionAdmission = require('../storage/connection-admission');
// LISTEN is committed before reconciliation starts. Messages are untrusted,
// coalesced hints only; the callback rereads current tenant-bound truth. Every
// tick has a constant page budget, including healthy operation (lost NOTIFY).
//
// Healthy rotation (decision cost-proportional-to-activity): hints are the
// normal path, so the rotating page is only the lost-hint backstop. Without
// config.sweepMs a healthy tick rotates one full page (a roster of pageSize or
// fewer is checked whole every tick). With it, healthy ticks together cover the
// roster once per sweepMs: each tick earns roster*elapsed/sweepMs tenants of
// rotation, never more than one page. Hinted tenants are still taken first on
// the next tick, up to a page; a degraded feed (no listener, a missing or late
// heartbeat, a new reader generation, an unfinished reconcile, a refused check)
// still rotates degradedPages full pages per tick. A lost hint is therefore
// found within sweepMs plus one tick while the roster fits (roster*intervalMs
// <= pageSize*sweepMs); a larger roster keeps the page-per-tick rate.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function create ({ config, tenants, check, connect, now = Date.now, schedule = setInterval, cancel = clearInterval,
  dynamic = false, maxTenants = 10000, alert = code => console.warn('Feed consumer alert',code) }) {
  const roster = [...tenants], known = new Set(roster), dirty = new Map();
  if (!Number.isSafeInteger(maxTenants) || maxTenants<1 || roster.length>maxTenants || (!dynamic && !roster.length) || known.size !== roster.length || roster.some(t => !UUID.test(t)) || typeof check !== 'function' || typeof connect !== 'function') throw new TypeError('Feed requires a fixed canonical tenant roster');
  let closed = false, client, connecting = null, timer, pending, cursor = 0, remaining = roster.length,
    heartbeat = null, generation = null, degraded = true, reported = false, lastFailure = null, credit = 0, creditAt = null;
  // Healthy rotation allowance for this tick. Time-based, so a slow tick does
  // not lengthen the sweep; capped at one page, so it never exceeds the budget.
  function healthyAmount () {
    const page = Math.min(config.pageSize,roster.length);
    if (config.sweepMs === undefined) return page;
    const at = now(), elapsed = creditAt === null ? config.intervalMs : Math.max(0,at-creditAt);
    creditAt = at; credit = Math.min(page,credit+roster.length*elapsed/config.sweepMs);
    const amount = Math.floor(credit); credit -= amount; return amount;
  }
  const counters = { pages: 0, checks: 0, hints: 0, refused: 0, reconnects: 0, sweeps: 0, rotated: 0 };
  function disconnected () { client = null; heartbeat = null; remaining = roster.length; degraded = true; }
  function message (event) {
    if (event.channel !== config.channel || typeof event.payload !== 'string' || Buffer.byteLength(event.payload) > 512) return;
    let value; try { value = JSON.parse(event.payload); } catch { return; }
    if (value?.v !== 1) return;
    if (value.k === 'heartbeat' && UUID.test(value.reader || '')) {
      if (generation !== value.reader) { generation = value.reader; remaining = roster.length; cursor = 0; }
      heartbeat = now(); return;
    }
    if (['data','activity','config','both'].includes(value.k) && known.has(value.t)) { const previous = dirty.get(value.t); dirty.set(value.t,previous && previous !== value.k ? 'both' : value.k); counters.hints++; }
  }
  async function ensure () {
    if (client || closed) return;
    if (connecting) return connecting;
    connecting = (async () => {
      let candidate;
      try {
        candidate = await connect();
        candidate.on('notification',message);
        const gone = () => { if (client === candidate) { disconnected(); candidate.end().catch(() => {}); } };
        candidate.on('error',gone); candidate.on('end',gone);
        await candidate.query('LISTEN "' + config.channel + '"');
        if (closed) { await candidate.end(); return; }
        client = candidate; remaining = roster.length; cursor = 0; heartbeat = null; counters.reconnects++;
      } catch { await candidate?.end().catch(() => {}); lastFailure = 'FEED_LISTENER_UNAVAILABLE'; disconnected(); }
    })().finally(() => { connecting = null; });
    return connecting;
  }
  function tick () {
    if (closed) return Promise.resolve(); if (pending) return pending;
    pending = (async () => {
      await ensure(); if (closed) return;
      degraded = !client || heartbeat === null || now() - heartbeat > config.heartbeatTimeoutMs || remaining > 0;
      if (degraded && !reported) { reported = true; try { alert('FEED_DEGRADED'); } catch { /* no dependency on alert sink */ } }
      if (!degraded) reported = false;
      const selected = new Set(), hints = new Map();
      for (const [tenant,kind] of dirty) { if (selected.size >= config.pageSize) break; selected.add(tenant); hints.set(tenant,kind); dirty.delete(tenant); }
      let covered = 0;
      const pages = degraded ? config.degradedPages : 1;
      if (degraded) { credit = 0; creditAt = null; }
      for (let page = 0; page < pages; page++) {
        const amount = degraded ? Math.min(config.pageSize,roster.length) : healthyAmount();
        for (let i = 0; i < amount; i++) { selected.add(roster[cursor]); cursor = (cursor + 1) % roster.length; if (!cursor) counters.sweeps++; }
        covered += amount; counters.rotated += amount; if (amount) counters.pages++;
      }
      // An empty selection is still passed on: the callback's per-pass work
      // (the evaluator's pool-membership read) keeps its tick cadence.
      try {
        await check([...selected],{ hints, recovery: degraded }); counters.checks += selected.size;
        remaining = Math.max(0,remaining-covered); lastFailure = null;
        degraded = !client || heartbeat === null || now()-heartbeat > config.heartbeatTimeoutMs || remaining > 0;
      } catch { counters.refused++; lastFailure = 'FEED_RECONCILIATION_REFUSED'; remaining = roster.length; degraded = true; }
    })().finally(() => { pending = null; });
    return pending;
  }
  return Object.freeze({ tick, message,
    addTenant (tenant) { if(!dynamic || !UUID.test(tenant) || known.size >= maxTenants && !known.has(tenant))throw new Error('Dynamic feed tenant refused');if(known.has(tenant))return;known.add(tenant);roster.push(tenant);remaining++;dirty.set(tenant,'both'); },
    removeTenant (tenant) { if(!dynamic)throw new Error('Dynamic feed tenant refused');known.delete(tenant);dirty.delete(tenant);const index=roster.indexOf(tenant);if(index>=0)roster.splice(index,1);cursor=roster.length?cursor%roster.length:0;remaining=Math.min(remaining,roster.length); },
    // Every tenant becomes hinted (a page per tick): for a caller whose own
    // admission changed (a pool slice), so pickup does not wait for the sweep.
    resync () { if (!closed) for (const tenant of roster) if (!dirty.has(tenant)) dirty.set(tenant,'both'); },
    async start () { await ensure(); if (!closed && !timer) timer = schedule(() => tick().catch(() => {}),config.intervalMs); await tick(); },
    health: () => ({ live: !closed, connected: !!client, degraded, recoveryRemaining: remaining,
      heartbeatAgeMs: heartbeat === null ? null : now()-heartbeat, refusal: lastFailure, ...counters }),
    async close () { closed = true; cancel(timer); await connecting; await pending; const current = client; client = null; await current?.end(); } });
}
async function start ({ config,tenants,check,dynamic=false,maxTenants=10000 }) {
  const { Client } = require('pg');
  const consumer = create({ config,tenants,check,dynamic,maxTenants, connect: async () => {
    const client = new (connectionAdmission.wrapClient(Client, 'nightscout-feed-listener'))({ connectionString: config.connectionString, application_name: 'nightscout-feed-listener',
      connectionTimeoutMillis: 2000, query_timeout: 2000, options: '-c statement_timeout=2000' });
    await client.connect(); return client;
  } });
  await consumer.start(); return consumer;
}
module.exports = { create, start };
