'use strict';
// Populated immutable-prefix upgrade through the actual runner; synthetic data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {Client} = require('pg');
const {run} = require('../lib/migrations/postgres');
const {optInSuite} = require('./support/opt-in');
const proposal = require('../lib/tenant-lifecycle/tenant-insertion-sql');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const catalogues = {
  entries: require('../migrations/candidates/postgres-entries-v1.json'),
  food: require('../migrations/candidates/postgres-food-v1.json'),
  treatments: require('../migrations/candidates/postgres-treatments-socket-order-v1.json'),
  devicestatus: require('../migrations/candidates/postgres-devicestatus-socket-order-v1.json'),
  profile: require('../migrations/candidates/postgres-profile-socket-order-v1.json')
};
optInSuite(process.env.NS_TENANT_INSERTION_UPGRADE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_INSERTION_UPGRADE_TEST=1 with disposable PostgreSQL')('tenant insertion populated runner upgrade', function () {
  this.timeout(60000);
  const prefix = 'ordup_' + crypto.randomBytes(7).toString('hex'), schemas = [];
  const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
  let admin;
  const q = name => '"' + name + '"';
  before(async () => { admin = new Client({connectionString:uri,statement_timeout:10000}); await admin.connect(); });
  after(async () => {
    const errors = [];
    for (const namespace of schemas.reverse()) try { await admin.query('DROP SCHEMA '+q(namespace)+' CASCADE'); } catch (error) { errors.push(error); }
    if (admin) await admin.end();
    if (errors.length) throw new globalThis.AggregateError(errors, 'Owned upgrade cleanup refused');
  });
  for (const domain of ['treatments','devicestatus','profile']) for (const populated of [false,true]) {
    it('upgrades standard size-projected '+domain+' only when the ordering source is empty ('+populated+')',async()=>{
      const namespace=prefix+'_standard_'+domain+'_'+(populated?'full':'empty');schemas.push(namespace);
      const standard=require('../migrations/candidates/postgres-'+domain+'-v1.json');
      const options={direct:true,connectionString:uri,namespace,statementTimeoutMs:10000};
      await admin.query('CREATE SCHEMA '+q(namespace));await run('up',{...options,catalogue:standard});
      const table=q(namespace)+'.'+q(domain);
      if(populated)await admin.query('INSERT INTO '+table+'(tenant_id,id_kind,doc) VALUES($1,$2,$3)',[A,'string',{_id:'preserved',synthetic:true}]);
      const history=async()=>(await admin.query('SELECT name,checksum FROM '+q(namespace)+'.schema_migrations ORDER BY name')).rows;
      const before=await history();
      if(populated){
        await assert.rejects(run('up',{...options,catalogue:catalogues[domain]}),/socket_order_requires_empty|check constraint/);
        assert.deepEqual(await history(),before,'POPULATED_ORDERING_REFUSAL_RETAINS_LEDGER');
        assert.equal((await admin.query('SELECT doc,storage_bytes=pg_column_size(doc) AS exact FROM '+table)).rows[0].exact,true);
      }else{
        const upgraded=await run('up',{...options,catalogue:catalogues[domain]});
        assert.deepEqual(upgraded.done,catalogues[domain].migrations.filter(m=>!before.some(row=>row.name===m.name)).map(m=>m.name));
        assert.equal((await run('check',{...options,catalogue:catalogues[domain]})).current,true);
      }
    });
  }
  for (const domain of proposal.DOMAINS) it('preserves populated '+domain+' values, seeds each tenant and refuses the older catalogue', async () => {
    const namespace = prefix+'_'+domain, catalogue = catalogues[domain];
    // Preserve the actual pre-conversion immutable history, independent of the new size tail.
    const old = {...catalogue,migrations:catalogue.migrations.filter(m=>m.operation?.kind!=='clinical-storage-size-v1').slice(0,-2)};
    const options = {direct:true,connectionString:uri,namespace,statementTimeoutMs:10000};
    schemas.push(namespace); await admin.query('CREATE SCHEMA '+q(namespace));
    await run('up',{...options,catalogue:old});
    const table = q(namespace)+'.'+q(domain);
    for (const [tenant,id] of [[A,'a1'],[B,'b1'],[A,'a2']]) await admin.query('INSERT INTO '+table+'(tenant_id,id_kind,doc) VALUES($1,$2,$3)',[tenant,'string',{_id:id,synthetic:true}]);
    const read = async () => (await admin.query('SELECT tenant_id,id_kind,doc,insertion_ordinal::text AS ordinal FROM '+table+' ORDER BY insertion_ordinal')).rows;
    const before = await read();
    await run('up',{...options,catalogue});
    assert.deepEqual(await read(),before);
    assert.equal((await admin.query('SELECT bool_and(storage_bytes=pg_column_size(doc)) AS exact FROM '+table)).rows[0].exact,true,'POPULATED_STORAGE_BACKFILL_EXACT');
    assert.equal((await run('check',{...options,catalogue})).current,true);
    assert.deepEqual((await admin.query('SELECT tenant_id,last_ordinal::text AS floor FROM '+q(namespace)+'.tenant_insertion_ordinal ORDER BY tenant_id')).rows,
      [{tenant_id:A,floor:'3'},{tenant_id:B,floor:'2'}]);
    await assert.rejects(run('check',{...options,catalogue:old}),error => error.code === 'MIG_UNKNOWN');
    assert.deepEqual(await read(),before);
    assert.equal((await admin.query('SELECT pg_get_serial_sequence($1,$2) AS sequence',[namespace+'.'+domain,'insertion_ordinal'])).rows[0].sequence,null);
    // A binding failure is a real transactional red; data and ledger stay unchanged.
    await assert.rejects(admin.query('INSERT INTO '+table+'(tenant_id,id_kind,doc) VALUES($1,$2,$3)',[A,'string',{_id:'unbound'}]),error => error.code === '42501');
    assert.deepEqual(await read(),before);
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[B]);
      const row = (await admin.query('INSERT INTO '+table+'(tenant_id,id_kind,doc) VALUES($1,$2,$3) RETURNING insertion_ordinal::text AS ordinal',[B,'string',{_id:'b2',synthetic:true}])).rows[0];
      assert.equal(row.ordinal,'3');
    } finally { await admin.query('ROLLBACK'); }
    assert.deepEqual(await read(),before);
    assert.equal((await run('check',{...options,catalogue})).current,true);
  });
});
