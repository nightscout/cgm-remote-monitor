'use strict';

// Source protocol: transactional SQL-shaped fake, NOT native PostgreSQL/RLS proof.
const assert = require('node:assert/strict');
const scope = require('../../lib/storage/tenant-scope');
const createStore = require('../../lib/tenant-notifications/postgres');
const createComponent = require('../../lib/tenant-notifications/component');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const copy = value => structuredClone(value);
module.exports = function fixture () {
  let requests = [], heads = [], states = [], inTransaction = false, failCommit = false, at = 10000000;
  let current = { tenant: A, identity: 'config-one', runtimeId: 'runtime-one', outputRevision: 1, inputCheckpoint: 0, eligible: true,
    result: { now: at, emitted: [] } };
  let suppressed = false, configCurrent = true, gateError, holdGate, unsafe = {};
  const calls = [], effects = [], completions = [], observedAttempts = [];
  const headKey = v => row => row.tenant_id === v[0] && row.consumer === v[1] && row.dedup_key === v[2];
  const request = v => requests.find(row => row.tenant_id === v[0] && row.request_id === v[1]);
  const layouts = {
    tenant_notification_heads: [['tenant_id','uuid',true],['consumer','text',true],['dedup_key','text',true],['request_id','uuid',false,true],['blocked_until','bigint',true,true]],
    tenant_notification_requests: [['tenant_id','uuid',true],['request_id','uuid',true],['consumer','text',true],['dedup_key','text',true],['origin','text',true],['config_identity','text',true],['payload','jsonb',true],['state','text',true,true],['created_at','bigint',true],['next_at','bigint',true,true],['attempt','integer',true,true],['attempt_token','uuid',false,true],['attempt_until','bigint',false,true],['accepted_at','bigint',false,true],['receipt','jsonb',false,true],['cleared_at','bigint',false,true]],
    tenant_notification_state: [['tenant_id','uuid',true],['consumer','text',true],['revision','bigint',true,true],['config_identity','text',true,true],['producer','jsonb',true,true]],
    schema_migrations: [['name','text',true],['checksum','text',true],['applied_at','timestamp with time zone',true]]
  };
  function metadata (table) {
    const ledger = table === 'schema_migrations';
    return { kind: 'r', persistence: 'p', secured: !ledger, owns: false, schema_writes: false, reads: true, inserts: !ledger,
      broad_writes: false, any_writes: !ledger,
      columns: layouts[table].map(([name,type,notNull,updates]) => ({ name, type, not_null: notNull, updates: !!updates, inserts: !ledger })),
      primary_key: ledger ? ['name'] : table.endsWith('state') ? ['tenant_id','consumer'] : table.endsWith('heads') ? ['tenant_id','consumer','dedup_key'] : ['tenant_id','request_id'],
      policies: ledger ? [] : [{ command: '*', roles: [0], permissive: true,
        using: "tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid",
        check: "tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid" }], ...unsafe.tables?.[table] };
  }
  const connection = {
    async transaction (fn) {
      assert.equal(inTransaction, false, 'new SQL transaction required');
      const before = { requests: copy(requests), heads: copy(heads), states: copy(states) }; inTransaction = true;
      try {
        const value = await fn();
        if (failCommit) throw new Error('SYNTHETIC_COMMIT_FAILURE');
        calls.push('COMMIT'); return value;
      } catch (error) { requests = before.requests; heads = before.heads; states = before.states; calls.push('ROLLBACK'); throw error; }
      finally { inTransaction = false; }
    },
    async query (sql, values) {
      assert.equal(inTransaction, true);
      calls.push({ sql, values: copy(values) }); const v = values;
      if (sql.includes('notification-readiness-role')) return { rows: [{ uses_schema: true, rolsuper: false, rolbypassrls: false,
        rolcreaterole: false, rolcreatedb: false, rolreplication: false, owns_schema: false, schema_writes: false,
        any_schema_writes: false, database_create: false, elevated_membership: false, foreign_writes: false, ...unsafe.role }] };
      if (sql.includes('notification-readiness-table')) return { rows: [metadata(values[0].split('.').at(-1))] };
      if (sql.includes('notification-readiness-ledger')) {
        const migrations = require('../../lib/tenant-notifications/postgres-candidate.json').migrations;
        return { rows: unsafe.ledger || migrations.map(({name, checksum}) => ({name, checksum})) };
      }
      if (sql.includes('notification-producer-lock')) return {rows: []};
      assert.equal(values[0], scope.currentTenant(), 'tenant SQL predicate');
      if (sql.startsWith('SELECT *') && sql.includes('tenant_notification_state')) return {rows: states.filter(row => row.tenant_id === v[0] && row.consumer === v[1]).map(copy)};
      if (sql.startsWith('INSERT INTO') && sql.includes('tenant_notification_state')) { states.push({tenant_id:v[0],consumer:v[1],revision:v[2],config_identity:v[3],producer:JSON.parse(v[4])}); return {rows:[]}; }
      if (sql.startsWith('UPDATE') && sql.includes('tenant_notification_state')) {
        const row = states.find(row => row.tenant_id === v[0] && row.consumer === v[1] && row.revision === v[5]);
        if (!row) return {rows:[]}; Object.assign(row,{revision:v[2],config_identity:v[3],producer:JSON.parse(v[4])}); return {rows:[copy(row)]};
      }
      if (sql.startsWith('INSERT INTO') && sql.includes('tenant_notification_heads')) {
        if (!heads.find(headKey(v))) heads.push({ tenant_id: v[0], consumer: v[1], dedup_key: v[2], blocked_until: 0, request_id: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT *') && sql.includes('tenant_notification_heads')) return { rows: heads.filter(headKey(v)).map(copy) };
      if (sql.startsWith('SELECT *') && sql.includes('request_id=$2')) return { rows: request(v) ? [copy(request(v))] : [] };
      if (sql.startsWith('INSERT INTO') && sql.includes('tenant_notification_requests')) {
        const row = { tenant_id: v[0], request_id: v[1], consumer: v[2], dedup_key: v[3], origin: v[4], config_identity: v[5],
          payload: JSON.parse(v[6]), state: 'pending', created_at: v[7], next_at: v[7], attempt: 0 };
        requests.push(row); return { rows: [copy(row)], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE') && sql.includes('SET request_id=')) {
        const row = heads.find(headKey(v)); row.request_id = v[3]; row.blocked_until = v[4]; return { rows: [], rowCount: 1 };
      }
      if (sql.includes('notification-producer-active')) return {rows: requests.filter(row => row.tenant_id === v[0] && row.consumer === v[1] && ['pending','uncertain','attempting'].includes(row.state)).slice(0,v[2]).map(copy)};
      if (sql.startsWith('SELECT *') && sql.includes('state IN')) return { rows: requests.filter(row => row.tenant_id === v[0] && row.consumer === v[1] && row.dedup_key.startsWith(v[2].slice(0,-1)) &&
        ((['pending', 'uncertain'].includes(row.state) && row.next_at <= v[3]) || (row.state === 'attempting' && row.attempt_until <= v[3])))
        .sort((a, b) => a.created_at - b.created_at).slice(0, v[4]).map(copy) };
      if (sql.startsWith('UPDATE') && sql.includes("SET state='cancelled'")) {
        const row = request(v); row.state = 'cancelled'; return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE') && sql.includes('SET attempt_until=$3')) {
        const row = request(v); assert.equal(row.attempt_token, v[3]); row.attempt_until = v[2]; return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE') && sql.includes("state='attempting'")) {
        const row = request(v); Object.assign(row, { state: 'attempting', attempt: row.attempt + 1, attempt_token: v[2], attempt_until: v[3] });
        return { rows: [copy(row)], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE') && sql.includes('SET state=$4')) {
        const row = request(v); assert.equal(row.attempt_token, v[2]);
        Object.assign(row, { state: v[3], next_at: v[4], accepted_at: v[5], receipt: JSON.parse(v[6]) }); return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE') && sql.includes('SET blocked_until=')) {
        const row = heads.find(headKey(v)); if (row.request_id === v[4]) row.blocked_until = v[3]; return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT request_id,receipt')) return { rows: requests.filter(row => row.tenant_id === v[0] && row.consumer === v[1] &&
        row.dedup_key.startsWith(v[2].slice(0,-1)) && row.state === 'accepted' && row.receipt != null && row.cleared_at == null && row.accepted_at >= v[3]).slice(0, v[4]).map(row => ({ request_id: row.request_id, receipt: copy(row.receipt) })) };
      if (sql.startsWith('UPDATE') && sql.includes('SET cleared_at=')) {
        requests.filter(row => row.tenant_id === v[0] && row.consumer === v[1] && v[2].includes(row.request_id) && row.state === 'accepted' && row.dedup_key.startsWith(v[4].slice(0,-1)))
          .forEach(row => { row.cleared_at = v[3]; }); return { rows: [], rowCount: 1 };
      }
      throw new Error('UNKNOWN_NOTIFICATION_SQL ' + sql);
    }
  };
  const store = createStore({ connection, namespace: 'notification_test', maxRows: 10, maxBytes: 65536 });
  const hooks = {
    store, now: () => at, normalPolicy: 'pushnotify', maxRows: 10, maxPayloadBytes: 10000, maxInflight: 2, attemptTimeoutMs: 30, retryDelayMs: 1,
    adapter: { id: 'synthetic', send (row, callback) {
      assert.equal(inTransaction, false, 'NOTIFICATION_COMMIT_BEFORE_DISPATCH');
      const stored = requests.find(r => r.request_id === row.id && r.tenant_id === row.tenant);
      observedAttempts.push({ id: row.id, storedState: stored?.state, inTransaction });
      assert.equal(stored?.state, 'attempting', 'NOTIFICATION_DURABLE_BEFORE_DISPATCH');
      effects.push(row); completions.push(callback); callback(null, { accepted: true, receipt: { id: 'receipt-' + row.id } });
    } },
    selectCycle: async () => current,
    isCurrent: async () => configCurrent,
    allows: async () => {
      if (gateError) throw gateError;
      if (holdGate) await holdGate;
      return !suppressed;
    }
  };
  return { A, B, connection, store, hooks, calls, effects, completions, observedAttempts,
    producerStates: () => copy(states),
    jsonbRoundTrip () {
      const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key,reorder(value[key])])) : value;
      for (const row of states) row.producer = reorder(row.producer);
    },
    component: overrides => createComponent({ ...hooks, ...overrides }),
    snapshot: () => ({ requests: copy(requests), heads: copy(heads) }),
    current: () => current,
    setCycle (emitted, changes = {}) { current = { ...current, outputRevision: current.outputRevision + 1, ...changes, result: { now: at, emitted } }; },
    advance (ms) { at += ms; }, now: () => at,
    suppressed (value = true) { suppressed = value; }, configCurrent (value) { configCurrent = value; },
    unsafe (value = {}) { unsafe = value; },
    gateError (value) { gateError = value; }, holdGate (value) { holdGate = value; }, failCommit (value = true) { failCommit = value; }
  };
};
module.exports.notification = (extra = {}) => ({ title: 'Synthetic alarm', message: 'Synthetic details', level: 1, group: 'default', plugin: { name: 'synthetic' }, ...extra });
