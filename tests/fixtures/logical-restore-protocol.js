'use strict';
// Transaction/storage protocol double. Native role/SQL/lock acceptance is separate.
const assert = require('node:assert/strict');
const scope = require('../../lib/storage/tenant-scope');
const artifacts = require('../../lib/tenant-lifecycle/artifact');
const clone = value => JSON.parse(JSON.stringify(value));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const BASE = 1700000000000;
const candidates = {
  entries: require('../../migrations/candidates/postgres-entries-v1.json'),
  profile: require('../../migrations/candidates/postgres-profile-socket-order-v1.json'),
  activity: require('../../migrations/candidates/postgres-activity-v1.json'),
  clock: require('../../migrations/candidates/postgres-write-clock-v1.json'),
  access: require('../../lib/tenant-authorization/access-candidate.json')
};
const row = (id, value, modified = 4000, ordinal = '1') => ({ tenant_id: A, id_kind: 'string',
  doc: { _id: id, identifier: id, value, created_at: '2023-11-14T00:00:00Z', srvCreated: BASE + 10, srvModified: BASE + modified }, insertion_ordinal: ordinal });
function fixture () {
  const catalogues = Object.entries(candidates).map(([kind, candidate]) => ({ kind, candidate,
    tables: kind === 'clock' ? ['tenant_write_clock'] : kind === 'access' ? ['access_tenants', 'access_credentials', 'access_sessions', 'access_keys'] : kind === 'activity' ? ['activity'] : ['tenant_insertion_ordinal', kind] }));
  const namespaces = Object.fromEntries(catalogues.map(entry => [entry.kind, 'logical_' + entry.kind]));
  const desired = { entries: [row('missing', 'old-missing', 1000, '5'), row('stable', 'same', 1000, '1'), row('changed', 'old', 1000, '3')],
    profile: [row('z-first', 'first', 1000, '1'), row('a-second', 'second', 1000, '2')],
    activity: [{ tenant_id: A, id_kind: 'string', doc: { _id: 'activity-old', created_at: '2023-11-14T00:00:00Z', value: 'old' } }] };
  for (const r of desired.profile) Object.assign(r.doc, { NSCLIENT_ID: 'synthetic', startDate: '2023-11-14', store: { Synthetic: { dia: r.doc._id === 'z-first' ? 3 : 9 } } });
  const durable = { clock: { [A]: String(BASE + 10000), [B]: String(BASE + 20000) }, counter: { entries: { [A]: '17', [B]: '29' }, profile: { [A]: '20', [B]: '30' } },
    tables: { entries: [row('stable', 'same', 4000, '7'), row('changed', 'newer', 5000, '11'), row('postbackup', 'new', 6000, '17'), { ...row('foreign', 'B-current', 20000, '29'), tenant_id: B }],
      profile: desired.profile.map(r => ({ ...clone(r), insertion_ordinal: r.doc._id === 'z-first' ? '11' : '3' })),
      activity: [{ tenant_id: A, id_kind: 'string', doc: { _id: 'activity-old', created_at: '2023-11-14T00:00:00Z', value: 'newer' } }, { tenant_id: A, id_kind: 'string', doc: { _id: 'activity-post', created_at: '2023-11-15T00:00:00Z' } }] },
    authority: { active: true, generation: 9, secret: 'CURRENT_SYNTHETIC_SECRET', checkpoint: 9999 } };
  const described = catalogues.filter(entry => entry.kind !== 'access').map(entry => ({ ...entry, namespace: namespaces[entry.kind], ledger: entry.candidate.migrations,
    tables: entry.tables.map(table => ({ table, columns: table === 'tenant_write_clock' ? [{ name: 'tenant_id', type: 'uuid' }, { name: 'last_stamp', type: 'bigint' }] : table === 'tenant_insertion_ordinal' ? [{ name: 'tenant_id', type: 'uuid' }, { name: 'last_ordinal', type: 'bigint' }] : [{ name: 'tenant_id', type: 'uuid' }, { name: 'id_kind', type: 'text' }, { name: 'doc', type: 'jsonb' }, ...(entry.kind !== 'activity' ? [{ name: 'insertion_ordinal', type: 'bigint' }] : [])],
      rows: table === 'tenant_write_clock' ? [{ tenant_id: A, last_stamp: '1000' }] : table === 'tenant_insertion_ordinal' ? [{ tenant_id: A, last_ordinal: '7' }] : desired[entry.kind] })) }));
  const artifact = artifacts.buildArtifact({ tenant: A, sourceCommit: 'f'.repeat(40), exportedAt: 1700000000000, catalogues: described });
  const f = { catalogues, namespaces, desired, artifact, durable, hooks: [], trace: [], token: Object.freeze({}), admissionCalls: 0 };
  const state = () => f.working || f.durable;
  const domain = sql => Object.keys(desired).find(kind => sql.includes('"' + namespaces[kind] + '"."' + kind + '"'));
  f.begin = () => { f.working = clone(f.durable); f.hooks = []; };
  f.rollback = () => { delete f.working; f.hooks = []; };
  f.commit = async () => { f.durable = f.working; delete f.working; for (const hook of f.hooks) await hook(); f.hooks = []; };
  f.appendB = () => { for (const target of [f.durable, f.working].filter(Boolean)) { target.counter.entries[B] = String(BigInt(target.counter.entries[B]) + 1n); const next = Number(target.clock[B]) + 1; target.tables.entries.push({ ...row('B-during', 'new-B', next - BASE, target.counter.entries[B]), tenant_id: B }); target.clock[B] = String(next); } };
  f.connection = { transaction: fn => fn(), afterCommit: fn => { assert(f.working); f.hooks.push(fn); }, query: async (sql, values = []) => {
    f.trace.push({ sql, values: clone(values) }); const s = state();
    if (sql.includes('logical-restore-clock-shape')) return { rows: [ { name: 'tenant_id', type: 'uuid', required: true, attidentity: '', attgenerated: '' }, { name: 'last_stamp', type: 'bigint', required: true, attidentity: '', attgenerated: '' } ] };
    if (sql.includes('logical-restore-clock-security')) return { rows: [{ secured: true, owns: false, elevated: false, serves: true, extra: false, augmented: false, policies: [{ command: '*', permissive: true, roles: ['0'], using: "tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid", check: "tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid" }] }] };
    if (sql.includes('schema_migrations')) { const entry = catalogues.find(e => sql.includes('"' + namespaces[e.kind] + '"')); return { rows: entry.candidate.migrations.map(({ name, checksum }) => ({ name, checksum })) }; }
    if (sql.includes('reviewed-relation-inventory')) { const entry = catalogues.find(e => namespaces[e.kind] === values[0]); return { rows: ['schema_migrations', ...entry.tables].map(name => ({ name, kind: 'r', partition: false, inherited: false })) }; }
    if (sql.includes('tenant-insertion-floor')) { const kind = domain(sql), rows = s.tables[kind].filter(r => r.tenant_id === values[0]); return { rows: [{ binding: scope.currentTenant(), last_ordinal: s.counter[kind][values[0]], maximum: rows.length ? String(rows.reduce((m, r) => BigInt(r.insertion_ordinal) > m ? BigInt(r.insertion_ordinal) : m, 0n)) : null }] }; }
    if (sql.startsWith('SELECT') && sql.includes('tenant_write_clock')) return { rows: s.clock[values[0]] === undefined ? [] : [{ last_stamp: s.clock[values[0]] }] };
    if (sql.startsWith('UPDATE') && sql.includes('tenant_write_clock')) { assert.equal(s.clock[values[1]], String(values[2])); s.clock[values[1]] = String(values[0]); return { rowCount: 1, rows: [] }; }
    const kind = domain(sql); if (!kind) throw new Error('Unmodelled SQL: ' + sql);
    if (sql.startsWith('DELETE')) { s.tables[kind] = s.tables[kind].filter(r => r.tenant_id !== values[0]); return { rows: [] }; }
    if (sql.startsWith('INSERT')) { const next = { tenant_id: values[0], id_kind: values[1], doc: JSON.parse(values[2]) }; if (s.counter[kind]) { const n = String(BigInt(s.counter[kind][values[0]] || '0') + 1n); s.counter[kind][values[0]] = n; next.insertion_ordinal = n; } s.tables[kind].push(next); return { rowCount: 1, rows: [] }; }
    let rows = s.tables[kind].filter(r => r.tenant_id === (values[0] === A || values[0] === B ? values[0] : scope.currentTenant()));
    if (sql.includes('ORDER BY restored.insertion_ordinal') || sql.includes('ORDER BY insertion_ordinal ASC')) rows = rows.slice().sort((a, b) => BigInt(a.insertion_ordinal) < BigInt(b.insertion_ordinal) ? -1 : 1);
    if (sql.includes('LIMIT') && kind === 'profile') rows = rows.filter(r => r.doc.NSCLIENT_ID === 'synthetic').slice(0, 1);
    return { rows: clone(rows) };
  } };
  return f;
}
async function withAdmission (f, fn) {
  const maintenance = require('../../lib/tenant-lifecycle/maintenance-window'), ready = require('../../lib/storage/postgres-insertion-readiness');
  const held = maintenance.assertHeld, metadata = ready.metadata;
  maintenance.assertHeld = async (token, options) => { assert.equal(token, f.token); assert.equal(options.connection, f.connection); assert.equal(options.tenant, A); assert.equal(options.artifactDigest, f.artifact.digest); f.admissionCalls++; if (f.failPrecommit && f.admissionCalls > 1) throw Object.assign(new Error('synthetic held claim lost'), { code: 'LIFECYCLE_RESTORE_CLAIM_LOST' }); };
  ready.metadata = async (connection, options) => { assert.equal(connection, f.connection); assert.equal(options.mode, 'restore'); };
  try { return await fn(); } finally { maintenance.assertHeld = held; ready.metadata = metadata; }
}
module.exports = { fixture, withAdmission, A, B, BASE, clone };
