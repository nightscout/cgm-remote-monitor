'use strict';
const assert = require('node:assert/strict');
const canonical = require('../lib/server/ordinary-deployment-grants');
const fixture = require('./fixtures/realtime-preview/bootstrap-grants');
const layoutFixture = require('./fixtures/multitenant-registry-layout');
const readiness = require('../lib/server/serve/evaluator-readiness');
const receipt = require('../lib/pgstream/realtime-receipt').COLUMNS;
const layout = () => require('./fixtures/realtime-preview/bootstrap-plan').layout('0123456789abcdef');
// SQL-map projection only; PostgreSQL execution and RLS remain native checks.
function projected(sql, l) {
  const columns = new Set(receipt), table = '"' + l.namespaces.rt_checkpoint + '"."tenant_consumer_checkpoint"', who = '"' + l.roles.realtime + '"';
  for (const statement of sql) {
    if (!statement.includes(table) || !statement.endsWith(who)) continue;
    const updates = /UPDATE\(([^)]+)\)/.exec(statement);
    if (updates) for (const column of updates[1].split(',')) {
      if (statement.startsWith('REVOKE ')) columns.delete(column); else columns.add(column);
    }
  }
  return { async query(statement, values) {
    if (statement.includes('FROM pg_roles WHERE rolname=current_user')) return {rows:[{rolsuper:false}]};
    if (statement.includes('WITH identities')) return {rows:[{creates:false,unrelated:false}]};
    const own = values[0] === l.namespaces.rt_checkpoint + '.tenant_consumer_checkpoint';
    return {rows:[{secured:true,reads:true,forbidden:false,updates:own,bookkeeping:own && receipt.every(column=>columns.has(column)),extra:own && [...columns].some(column=>!receipt.includes(column))}]};
  }};
}
function config(l) { return {namespaces:{clock:l.namespaces.clock,checkpoint:l.namespaces.rt_checkpoint},completedOutput:{namespace:l.namespaces.eval_checkpoint}}; }
describe('ordinary deployment shared grant composition (source protocol)', function () {
  it('shares owner/lifetime helpers and consumes canonical registry/realtime grants', function () {
    assert.equal(layoutFixture.ownerGrants,canonical.ownerGrants);
    assert.equal(layoutFixture.lifetimeGrants,canonical.lifetimeGrants);
    const l=layout(), statements=fixture.grants(l);
    for(const sql of [...canonical.ownerGrants(l),...canonical.lifetimeGrants(l,Object.keys(l.roles)),...canonical.realtimeGrants(l),...canonical.registryGrants(l)])assert(statements.includes(sql),sql);
  });
  it('adds the native lifecycle column reads only for the selected serving identities', function () {
    const l = layout();
    const native = require('../lib/tenant-lifecycle/native-selection');
    const selection = native.create({ namespace: l.namespaces.eval_checkpoint, lifecycleNamespace: l.namespaces.control, consumer: 'evaluator-main' });
    const serving = ['owner_reader', 'lifetime_tenant_admin'];
    const base = canonical.lifetimeGrants(l, serving);
    const selected = canonical.lifetimeGrants(l, serving, selection);
    assert.deepEqual(selected.filter(sql => !base.includes(sql)),
      serving.flatMap(who => native.servingGrants({ namespace: l.namespaces.control, role: l.roles[who] })));
  });
  it('gives the shared fixture API the current activity reader capability', function () {
    const l = layoutFixture.layout('synthetic_activity'), sql = layoutFixture.grants(l);
    for (const statement of require('../lib/tenant-activity/postgres').grants({ namespace: l.namespaces.control, reader: l.roles.api })) {
      assert(sql.includes(statement), statement);
    }
  });
  it('keeps realtime/evaluator on registry functions and API/owner on row reads', function () {
    const l=layout(), sql=canonical.registryGrants(l).join('\n');
    for(const name of ['api','owner_reader'])assert(sql.includes('tenant_registry_keys TO "'+l.roles[name]+'"'));
    for(const name of ['realtime','evaluator'])assert(!sql.includes('tenant_registry_keys TO "'+l.roles[name]+'"'));
    assert(sql.includes('tenant_registry_lookup(text, text) TO "'+l.roles.realtime+'"'));
    assert(sql.includes('tenant_registry_tenants(uuid, integer) TO "'+l.roles.evaluator+'"'));
    assert.throws(()=>canonical.registryGrants({...l,roles:{api:'invalid-role'}}),/explicit roles/);
  });
  it('repeated base retirement preserves exact receipt rights supplied by maintained init', async function () {
    const l=layout(), sql=fixture.grants(l);
    assert(!canonical.realtimeGrants(l).some(value=>value.startsWith('GRANT ')&&value.includes('UPDATE')));
    await readiness.screen(projected(sql,l),config(l));
    await readiness.screen(projected([...sql,...sql],l),config(l));
  });
  it('actual readiness refuses old cursor and unknown extra rights; restored map passes', async function () {
    const l=layout(), sql=fixture.grants(l), table='"'+l.namespaces.rt_checkpoint+'"."tenant_consumer_checkpoint"', role='"'+l.roles.realtime+'"';
    for(const extra of ['checkpoint,projection,contract_digest','unknown_future_column']){
      await assert.rejects(readiness.screen(projected([...sql,'GRANT UPDATE('+extra+') ON '+table+' TO '+role],l),config(l)),/unsafe evaluator table privileges/);
      await readiness.screen(projected(sql,l),config(l));
    }
  });
});
