'use strict';
// Spike S2 (writer-driven transport): APIv3 `/storage` live events from the
// api's own post-commit emitters, with no storage-event journal.
//
// Single tenant: the APIv3 write handlers emit `storage-socket-{create,update,
// delete}` on ctx.bus after their write returns (lib/api3/generic/*), and
// lib/api3/storageSocket.js:48-50 broadcasts them. Multitenant uses the same
// handlers and the same bus events; this module carries them from the api's
// per-tenant bus to realtime as one hint {tenant, generation, events}.
//
// Best-effort: a lost hint is never retried. A client recovers as after any
// socket drop, through GET /api/v3/{collection}/history.
const EVENTS = Object.freeze({ 'storage-socket-create': 'create', 'storage-socket-update': 'update', 'storage-socket-delete': 'delete' });
const KIND = 'storage-events-hint-v1';

function event (name, value) {
  const kind = EVENTS[name];
  if (!kind || !value || typeof value.colName !== 'string') return null;
  if (kind === 'delete') return typeof value.identifier === 'string' ? { event: kind, colName: value.colName, identifier: value.identifier } : null;
  return value.doc && typeof value.doc === 'object' ? { event: kind, colName: value.colName, doc: structuredClone(value.doc) } : null;
}

// api side. `deliver` is the realtime entry (in-process: a function call; S3
// owns the HTTP contract). `currentGeneration` reads the restore generation of
// the request's own operation window; a write outside a window sends nothing.
function sender ({ deliver, currentGeneration, onError = () => {} }) {
  if (typeof deliver !== 'function') throw new TypeError('Storage hint delivery required');
  const counters = { sent: 0, skipped: 0, failed: 0 };
  function attach (bus, tenant) {
    for (const name of Object.keys(EVENTS)) bus.on(name, value => send(tenant, name, value));
  }
  function send (tenant, name, value) {
    let generation;
    try { generation = currentGeneration ? String(currentGeneration(tenant)) : null; } catch { counters.skipped++; return; }
    const change = event(name, value);
    if (!change) { counters.skipped++; return; }
    counters.sent++;
    // The write path never waits on, or fails because of, delivery.
    Promise.resolve().then(() => deliver({ kind: KIND, tenant, generation, events: [change] }))
      .catch(error => { counters.failed++; onError(error); });
  }
  return Object.freeze({ attach, send, stats: () => ({ ...counters }) });
}

function validate (hint) {
  const ok = hint && hint.kind === KIND && typeof hint.tenant === 'string' && (hint.generation === null || typeof hint.generation === 'string') &&
    Array.isArray(hint.events) && hint.events.length > 0 && hint.events.every(e => e && ['create', 'update', 'delete'].includes(e.event) &&
      typeof e.colName === 'string' && (e.event === 'delete' ? typeof e.identifier === 'string' : !!e.doc && typeof e.doc === 'object'));
  if (!ok) { const error = new Error('REALTIME_STORAGE_HINT_CONTRACT'); error.code = 'REALTIME_STORAGE_HINT_CONTRACT'; throw error; }
  return hint;
}

// The wire value single tenant emits: the bus event itself, {colName, doc} or
// {colName, identifier} (lib/api3/storageSocket.js:145-171).
const wire = e => e.event === 'delete' ? { colName: e.colName, identifier: e.identifier } : { colName: e.colName, doc: e.doc };

module.exports = { KIND, EVENTS, sender, validate, wire };
