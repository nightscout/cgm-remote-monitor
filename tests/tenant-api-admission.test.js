'use strict';
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const serving = require('../lib/tenant-activity/serving');
const eligibility = require('../lib/tenant-activity/eligibility');
const create = require('../lib/server/serve/api-admission');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function fixture(factory = create) {
  const tx = new AsyncLocalStorage(), calls = [];
  const state = new Map([[A, { paused: false, suspended: false }], [B, { paused: false, suspended: false }]]);
  let id = 0;
  const connection = {
    async withTenant(tenant, fn) {
      const active = tx.getStore();
      if (active) { assert.equal(active.tenant, tenant); return fn(); }
      return scope.withTenant(tenant, () => tx.run({ tenant, id: ++id }, async () => {
        calls.push(['BEGIN', tenant, id]);
        try { const result = await fn(); calls.push(['COMMIT', tenant, tx.getStore().id]); return result; }
        catch(error) { calls.push(['ROLLBACK', tenant, tx.getStore().id]); throw error; }
      }));
    },
    transaction(fn) { assert.equal(tx.getStore(), undefined); return this.withTenant(scope.requireTenant(), fn); },
    async query(label) { assert.equal(scope.currentTenant(), tx.getStore().tenant); calls.push([label, scope.currentTenant(), tx.getStore().id]); }
  };
  const gate = serving.createServingGate(eligibility.create({ read: async tenant => {
    await connection.withTenant(tenant, () => connection.query('activity'));
    const row = state.get(tenant); return row ? { tenant, version: 1, ...row, state: require('../lib/tenant-activity/policy').stateOf(row) } : null;
  } }));
  return { ...factory(connection, gate), calls, state, connection };
}
describe('API role-owned activity/request/effect transaction', function() {
  let prior;
  beforeEach(() => { prior = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(prior));
  it('joins activity and current authority to one tenant transaction and repeats activity at the effect', async function() {
    const f = fixture();
    await f.request(A, {method:'POST'}, () => f.connection.withTenant(A, () => f.connection.query('authority')));
    await scope.withTenant(A, () => f.writes.transaction(() => f.connection.query('mutation')));
    assert.deepEqual(f.calls.map(row => row[0]), ['BEGIN','activity','authority','COMMIT','BEGIN','activity','mutation','COMMIT']);
    assert.equal(new Set(f.calls.slice(0,4).map(row=>row[2])).size, 1);
    f.state.get(A).suspended = true;
    await assert.rejects(scope.withTenant(A, () => f.writes.transaction(() => f.connection.query('forbidden'))), {code:'TENANT_SUSPENDED'});
    assert.equal(f.calls.some(row=>row[0]==='forbidden'),false);
    await f.request(B, {method:'GET'}, () => f.connection.query('foreign-independent'));
  });
  it('allows paused uploads, refuses paused reads and all suspended effects without caching an earlier allow', async function() {
    const f = fixture();
    f.state.get(A).paused = true;
    await f.request(A, {method:'POST'}, async()=>{});
    await assert.rejects(f.request(A, {method:'GET'}, async()=>{}), {code:'TENANT_PAUSED'});
    f.state.get(A).suspended = true;
    await assert.rejects(f.request(A, {method:'POST'}, async()=>{}), {code:'TENANT_SUSPENDED'});
    f.state.delete(A);
    await assert.rejects(f.request(A, {method:'POST'}, async()=>{}), {code:'TENANT_ACTIVITY_UNAVAILABLE'});
  });
  it('rechecks authority at the effect after a queued wait and rejects foreign request context',async()=>{
    const f=fixture();let allowed=true,checks=0;
    await f.context(A,{},async()=>{
      await f.request(A,{method:'POST'},async()=>true,async()=>{checks++;return allowed;});
      allowed=false;
      await assert.rejects(scope.withTenant(A,()=>f.writes.transaction(()=>f.connection.query('forbidden'))),{code:'TENANT_DATA_FORBIDDEN'});
      assert.equal(checks,1);allowed=true;
      await scope.withTenant(A,()=>f.writes.transaction(()=>f.connection.query('restored')));
      await assert.rejects(scope.withTenant(B,()=>f.writes.transaction(()=>f.connection.query('foreign'))),{code:'TENANT_DATA_FORBIDDEN'});
    });
    assert.equal(f.calls.some(row=>['forbidden','foreign'].includes(row[0])),false);
  });
  it('red/restored: removing the current-effect check permits a forbidden mutation', async function() {
    const file = require.resolve('../lib/server/serve/api-admission'), needle = "await gate(tenant, { method: 'POST' });";
    const original = fs.readFileSync(file,'utf8'); assert(original.includes(needle));
    const m = new Module(file,module); m.filename=file; m.paths=Module._nodeModulePaths(require('node:path').dirname(file)); m._compile(original.replace(needle,''),file);
    const criterion = async factory => { const f=fixture(factory); f.state.get(A).suspended=true;
      await assert.rejects(scope.withTenant(A,()=>f.writes.transaction(()=>f.connection.query('mutation'))),{code:'TENANT_SUSPENDED'}); };
    await assert.rejects(criterion(m.exports),assert.AssertionError); await criterion(create);
  });
});
