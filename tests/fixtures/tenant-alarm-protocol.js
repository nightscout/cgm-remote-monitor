'use strict';

// In-memory SQL protocol double only. Native PostgreSQL is a separate opt-in.
const assert = require('node:assert/strict');
const scope = require('../../lib/storage/tenant-scope');
const { createWriter, createReader } = require('../../lib/tenant-alarms/postgres');
const { createReceiver, createCycle } = require('../../lib/tenant-alarms/composition');
const { createForwarder } = require('../../lib/server/tenant-socket-forwarding');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
module.exports = function protocol () {
  const calls = [], committed = new Map(), credentials = new Map([['owner-a', A], ['owner-b', B]]);
  let now = 10000000, allowed = true, transportAllowed = true, requestTenant = A, currentCredential = 'owner-a';
  let queue = Promise.resolve(), staged, failCommit = false, holdCommit, failRead = false, holdRead;
  const clone = value => structuredClone(value);
  const key = (tenant, group, level) => JSON.stringify([tenant, group, level]);
  const db = {
    async transaction (fn) {
      let unlock; const previous = queue; queue = new Promise(resolve => { unlock = resolve; }); await previous;
      staged = new Map([...committed].map(([k, v]) => [k, clone(v)]));
      try {
        calls.push('BEGIN'); const result = await fn();
        if (holdCommit) await holdCommit;
        if (failCommit) throw new Error('SYNTHETIC_COMMIT_REFUSAL');
        committed.clear(); for (const [k, v] of staged) committed.set(k, clone(v));
        calls.push('COMMIT'); return result;
      } catch (error) { calls.push('ROLLBACK'); throw error; }
      finally { staged = undefined; unlock(); }
    },
    async snapshotTransaction (fn) { return fn(); },
    async query (text, values) {
      calls.push({ text, values });
      if (text.startsWith('SELECT c.relrowsecurity')) return { rows: [{ secured: true, owns: false, reads: true, inserts: true, state_updates: true, broad_writes: false, any_writes: false, schema_writes: false }] };
      if (text.includes('clock_timestamp()')) return { rows: [{ now_ms: String(now) }] };
      if (text.startsWith('INSERT')) {
        assert.ok(staged, 'write must be inside transaction');
        const [tenant, group, level, at, expiry] = values;
        assert.equal(scope.currentTenant(), tenant, 'real current tenant scope');
        const k = key(tenant, group, level), old = staged.get(k);
        const conditional = text.includes('WHERE existing.expires_at <= EXCLUDED.acked_at');
        if (conditional && old && Number(old.expires_at) > at) return { rows: [], rowCount: 0 };
        const row = { tenant_id: tenant, alarm_group: group, alarm_level: level, acked_at: String(at), expires_at: String(expiry) };
        staged.set(k, row); return { rows: [clone(row)], rowCount: 1 };
      }
      if (text.startsWith('SELECT tenant_id') && text.includes('alarm_group=$2')) {
        const row = (staged || committed).get(key(...values)); return { rows: row ? [clone(row)] : [] };
      }
      if (text.startsWith('SELECT tenant_id')) {
        if (holdRead) await holdRead;
        if (failRead) throw new Error('SYNTHETIC_SUPPRESSION_READ_FAILURE');
        const [tenant, at, limit] = values;
        assert.equal(scope.currentTenant(), tenant, 'reader tenant binding');
        return { rows: [...committed.values()].filter(row => row.tenant_id === tenant && Number(row.expires_at) >= at)
          .sort((a, b) => a.alarm_group.localeCompare(b.alarm_group) || a.alarm_level - b.alarm_level).slice(0, limit).map(clone) };
      }
      throw new Error('Unexpected SQL protocol');
    }
  };
  const authorize = async operation => allowed && credentials.get(operation.credential) === operation.tenant;
  const writer = createWriter({ connection: db, namespace: 'alarm_protocol', authorizeInTransaction: ({ operation }) => authorize(operation) });
  function authObject (operation) { return allowed && credentials.get(operation.credential?.id) === operation.tenant; }
  const actualReceiver = createReceiver({ connection: db, namespace: 'alarm_protocol',
    authenticateTransport: async () => transportAllowed, resolveTenant: async () => requestTenant,
    authorizeSocket: async op => authObject(op) ? { tenant: op.tenant, principal: 'synthetic-subject' } : null,
    async authorizeAckInTransaction (op) { calls.push('AUTHORITY_IN_TRANSACTION'); assert.ok(staged); return authObject(op); },
    executeWrite: async () => { throw new Error('No data writes in alarm capability'); } });
  const actualForwarder = createForwarder({ contextForSocket: async () => ({ tenant: requestTenant, credential: { id: currentCredential } }),
    transport: envelope => actualReceiver({}, envelope) });
  return { A, B, db, calls, committed, writer, receiver: actualReceiver, forwarder: actualForwarder,
    reader: createReader({ connection: db, namespace: 'alarm_protocol', maxRows: 20, maxBytes: 10000 }),
    createCycle: current => createCycle({ connection: db, namespace: 'alarm_protocol', maxRows: 20, maxBytes: 10000, current, isCurrent: async () => true }),
    operation: (level = 1, group = 'default', duration = 1000, tenant = A) => ({ tenant, args: [level, group, duration], credential: tenant === A ? 'owner-a' : 'owner-b' }),
    rows: () => clone([...committed.values()]),
    set now (value) { now = value; }, get now () { return now; },
    set allowed (value) { allowed = value; }, set failCommit (value) { failCommit = value; },
    set holdCommit (value) { holdCommit = value; }, set failRead (value) { failRead = value; },
    set holdRead (value) { holdRead = value; }, set transportAllowed (value) { transportAllowed = value; },
    set tenant (value) { requestTenant = value; currentCredential = value === A ? 'owner-a' : 'owner-b'; }
  };
};
module.exports.A = A; module.exports.B = B;
