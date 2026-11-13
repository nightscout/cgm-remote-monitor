'use strict';
// Bounded metadata-only PostgreSQL lab. Run against a fresh disposable database.
// No clinical acquisition, full deployment, socket authorization or capacity claim.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { Client } = require('pg');
const worker = require('../../lib/trusted-worker/postgres');
const ns = { activity: 'tw_activity', clock: 'tw_clock', settings: 'tw_settings', operatorPolicy: 'tw_policy' };
const ids = Array.from({ length: 10000 }, (_, i) => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'));
const table = (name, relation) => '"' + ns[name] + '".' + relation;
const A = ids[0], B = ids[1];
let admin, connection, publicClient, phase = 'setup';
async function main () {
  const base = new URL(process.env.TRUSTED_WORKER_TEST_URL);
  admin = new Client({ connectionString: base.toString() }); await admin.connect();
  const version = (await admin.query('SELECT version()')).rows[0].version;
  for (const role of ['tw_worker', 'tw_public', 'tw_clock_owner']) await admin.query('CREATE ROLE ' + role + ' ' + (role === 'tw_clock_owner' ? 'NOLOGIN' : "LOGIN PASSWORD 'synthetic-test-only'") + ' NOSUPERUSER NOBYPASSRLS');
  for (const name of Object.values(ns)) await admin.query('CREATE SCHEMA "' + name + '"');
  const tables = [
    [table('activity', 'tenant_activity'), 'tenant_id uuid PRIMARY KEY,version integer NOT NULL,paused boolean NOT NULL,suspended boolean NOT NULL'],
    [table('clock', 'tenant_write_clock'), 'tenant_id uuid PRIMARY KEY,last_stamp bigint NOT NULL,last_delete_stamp bigint NOT NULL'],
    [table('settings', 'tenant_settings'), 'tenant_id uuid PRIMARY KEY,version integer NOT NULL,values jsonb NOT NULL'],
    [table('operatorPolicy', 'tenant_operator_policy'), 'tenant_id uuid PRIMARY KEY,generation integer NOT NULL,policy jsonb NOT NULL']
  ];
  for (const [name, fields] of tables) {
    await admin.query('CREATE TABLE ' + name + '(' + fields + ')');
    await admin.query('ALTER TABLE ' + name + ' ENABLE ROW LEVEL SECURITY');
    await admin.query('ALTER TABLE ' + name + ' FORCE ROW LEVEL SECURITY');
    await admin.query("CREATE POLICY tenant_scope ON " + name + " USING(tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid)");
    await admin.query('GRANT USAGE ON SCHEMA ' + name.split('.')[0] + ' TO tw_public');
    await admin.query('GRANT SELECT ON ' + name + ' TO tw_public');
  }
  await admin.query('INSERT INTO ' + table('activity', 'tenant_activity') + " SELECT id,1,false,false FROM unnest($1::uuid[]) id", [ids]);
  await admin.query('INSERT INTO ' + table('clock', 'tenant_write_clock') + ' SELECT id,1,0 FROM unnest($1::uuid[]) id', [ids]);
  await admin.query('INSERT INTO ' + table('settings', 'tenant_settings') + " SELECT id,1,'{}'::jsonb FROM unnest($1::uuid[]) id", [ids]);
  await admin.query('INSERT INTO ' + table('operatorPolicy', 'tenant_operator_policy') + " SELECT id,1,'{\"deployment\":{},\"overrides\":{}}'::jsonb FROM unnest($1::uuid[]) id", [ids]);
  for (const sql of worker.grants({ namespaces: ns, roles: ['tw_worker'] })) await admin.query(sql);
  await admin.query('CREATE TABLE tw_settings.synthetic_secret(value text)');
  base.username = 'tw_worker'; base.password = 'synthetic-test-only';
  connection = await require('../../lib/storage/postgres-connection')({ connectionString: base.toString(), max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-trusted-worker-lab' });
  const calls = [];
  const observed = { async readOnly (sql, values) { const started = performance.now(); const result = await connection.readOnly(sql, values); calls.push({ sql, values, ms: performance.now() - started }); return result; } };
  const reader = worker.create({ connection: observed, namespaces: ns }); await reader.verify();
  assert.equal((await reader.scan([A, B])).size, 2);
  assert.ok(reader.current(A) && reader.current(B), 'native worker sees both tenants without discriminator');
  const first = await reader.read(A), before = calls.length;
  for (let i = 0; i < 100; i++) assert.equal(await reader.read(A), first);
  assert.equal(calls.length, before, 'native unchanged settings has zero statements');
  await admin.query('UPDATE ' + table('settings', 'tenant_settings') + " SET version=2,values='{\"SHOW_SECONDS\":true}'::jsonb WHERE tenant_id=$1", [A]);
  await reader.scan([A, B]); assert.equal((await reader.read(A)).version, 2);
  await assert.rejects(connection.readOnly('SELECT * FROM tw_settings.synthetic_secret'), { code: '42501' });
  // A reader's read-only connection is not itself a privilege proof. Direct
  // login attempts independently establish that writes are denied by GRANT.
  const negative = new Client({ connectionString: base.toString() }); await negative.connect();
  try {
    for (const sql of ['UPDATE tw_settings.tenant_settings SET version=3', 'DELETE FROM tw_clock.tenant_write_clock', 'CREATE TABLE tw_clock.forbidden(x integer)']) await assert.rejects(negative.query(sql), { code: '42501' });
  } finally { await negative.end(); }
  base.username = 'tw_public'; publicClient = new Client({ connectionString: base.toString() }); await publicClient.connect();
  assert.equal((await publicClient.query('SELECT tenant_id FROM tw_settings.tenant_settings')).rows.length, 0);
  await publicClient.query("SELECT set_config('app.current_tenant_id',$1,false)", [A]);
  assert.deepEqual((await publicClient.query('SELECT tenant_id::text FROM tw_settings.tenant_settings')).rows, [{ tenant_id: A }]);
  assert.equal((await publicClient.query('SELECT tenant_id FROM tw_settings.tenant_settings WHERE tenant_id=$1', [B])).rows.length, 0, 'native public A cannot see B');
  phase = 'native-policy-controls';
  const controls = [];
  async function expectedRed (name, fn) {
    let symptom;
    try { await fn(); } catch (error) { symptom = error.code || error.name; }
    assert.equal(symptom, 'ERR_ASSERTION', name + ': the independent assertion must fail');
    controls.push({ name, symptom });
  }
  const policyStatements = worker.grants({ namespaces: ns, roles: ['tw_worker'] });
  const settingsPolicy = policyStatements.find(sql => sql.startsWith('CREATE POLICY') && sql.includes('tw_settings'));
  const settingsPolicyName = /^CREATE POLICY ("[^"]+")/.exec(settingsPolicy)[1];
  await admin.query('DROP POLICY ' + settingsPolicyName + ' ON tw_settings.tenant_settings');
  await expectedRed('missing-worker-policy', async () => {
    const rows = await reader.scan([A, B]);
    assert.ok([...rows.values()].every(row => Number.isInteger(row.settings)), 'worker must see assigned metadata across tenants');
  });
  await admin.query(settingsPolicy);
  assert.ok([...await reader.scan([A, B])].every(([, row]) => Number.isInteger(row.settings)));
  await admin.query('ALTER POLICY tenant_scope ON tw_settings.tenant_settings USING(true)');
  await expectedRed('public-policy-widened', async () => {
    const rows = await publicClient.query('SELECT tenant_id FROM tw_settings.tenant_settings WHERE tenant_id=$1', [B]);
    assert.equal(rows.rows.length, 0, 'public A must not see B');
  });
  await admin.query("ALTER POLICY tenant_scope ON tw_settings.tenant_settings USING(tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid)");
  assert.equal((await publicClient.query('SELECT tenant_id FROM tw_settings.tenant_settings WHERE tenant_id=$1', [B])).rows.length, 0);
  await admin.query('GRANT UPDATE(last_stamp) ON tw_clock.tenant_write_clock TO tw_worker');
  await assert.rejects(reader.verify(), { code: 'TRUSTED_WORKER_UNAVAILABLE' });
  controls.push({ name: 'worker-write-grant', symptom: 'TRUSTED_WORKER_UNAVAILABLE' });
  await admin.query('REVOKE UPDATE(last_stamp) ON tw_clock.tenant_write_clock FROM tw_worker');
  await reader.verify();
  // Original procedural clock function, extracted verbatim from shipping source.
  phase = 'procedural-comparison-setup';
  const source = require('../../lib/change-stamps/postgres-candidate.json');
  const definition = source.migrations.flatMap(m => m.up).filter(sql => sql.startsWith('CREATE FUNCTION tenant_change_stamps')).at(-1);
  await admin.query('SET search_path=tw_clock,pg_catalog'); await admin.query(definition);
  await admin.query('ALTER FUNCTION tw_clock.tenant_change_stamps(uuid[]) OWNER TO tw_clock_owner');
  await admin.query('ALTER FUNCTION tw_clock.tenant_change_stamps(uuid[]) SET search_path=tw_clock,pg_catalog');
  await admin.query('GRANT USAGE ON SCHEMA tw_clock TO tw_clock_owner');
  await admin.query('GRANT SELECT ON tw_clock.tenant_write_clock TO tw_clock_owner');
  await admin.query('GRANT EXECUTE ON FUNCTION tw_clock.tenant_change_stamps(uuid[]) TO tw_worker');
  phase = 'procedural-comparison';
  const timings = [];
  for (const n of [10, 1000, 10000]) {
    const list = ids.slice(0, n); await reader.scan(list);
    for (let repeat = 0; repeat < 2; repeat++) {
      const old = await observed.readOnly('SELECT * FROM tw_clock.tenant_change_stamps($1::uuid[])', [list]); assert.equal(old.rows.length, n);
      const oldMs = calls.at(-1).ms;
      const current = await reader.scan(list); assert.equal([...current.values()].filter(Boolean).length, n);
      const setBasedMs = calls.at(-1).ms;
      timings.push({ n, repeat, proceduralClockOnlyMs: oldMs, setBasedFourTableMetadataMs: setBasedMs });
    }
  }
  await reader.close();
  console.log(JSON.stringify({ status: 'PASS', scope: 'metadata-only native module and grant boundary, not full deployment or capacity', version, assertions: ['cross-tenant worker visibility', 'unchanged zero settings SQL', 'settings version refresh', 'worker negative grants', 'public tenant isolation'], timings, controls, operationalChecks: reader.health().operationalChecks }, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ phase, code: error.code || error.name, message: error.message, stack: error.stack })); process.exitCode = 1; }).finally(async () => { await Promise.allSettled([connection?.end(), publicClient?.end(), admin?.end()]); });
