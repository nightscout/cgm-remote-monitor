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
  it('installs the same reviewed entries indexes on populated upgrade and fresh installation', async () => {
    const catalogue = catalogues.entries;
    const previous = catalogue.migrations.findIndex(m => m.name === '0101_entries_redundant_indexes');
    assert.ok(previous >= 0);
    const old = {...catalogue, migrations: catalogue.migrations.slice(0, previous + 1)};
    const dropped = ['entries_tenant_mbg', 'entries_tenant_sgv', 'entries_tenant_datestring',
      'entries_tenant_systime', 'entries_tenant_type_date_datestring'];
    const upgraded = prefix + '_numeric_upgrade', fresh = prefix + '_numeric_fresh';
    const options = namespace => ({direct: true, connectionString: uri, namespace, catalogue});
    const indexes = async namespace => (await admin.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='entries' ORDER BY indexname",
      [namespace])).rows.map(row => row.indexname);
    const table = q(upgraded) + '.entries';
    const values = async () => (await admin.query(
      'SELECT tenant_id, id_kind, doc, sgv, mbg, insertion_ordinal FROM ' + table + ' ORDER BY tenant_id')).rows;

    for (const ns of [upgraded, fresh]) {
      await admin.query('CREATE SCHEMA ' + q(ns));
      schemas.push(ns);
    }
    await run('up', {...options(upgraded), catalogue: old});
    const before = await indexes(upgraded);
    for (const name of dropped) assert.ok(before.includes(name), name);
    await admin.query('BEGIN');
    try {
      for (const [tenant, doc] of [[A, {_id:'shared', type:'sgv', sgv:110}], [B, {_id:'shared', type:'mbg', mbg:120}]]) {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
        await admin.query('INSERT INTO ' + table + ' (tenant_id,id_kind,doc) VALUES ($1,$2,$3)', [tenant,'string',doc]);
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    const populated = await values();
    await run('up', options(upgraded));
    await run('up', options(fresh));
    assert.deepEqual((await admin.query('SELECT received_ms FROM ' + table)).rows, [{ received_ms: null }, { received_ms: null }]);
    const expected = [...before.filter(name => !dropped.includes(name)), 'entries_tenant_follower_exception',
      'entries_tenant_type_date', 'entries_tenant_event_ms', 'entries_tenant_systime_sparse', 'entries_tenant_datestring_sparse'].sort();
    for (const ns of [upgraded, fresh]) {
      assert.deepEqual(await indexes(ns), expected);
      assert.equal((await run('check', options(ns))).current, true);
      assert.deepEqual((await run('up', options(ns))).done, []);
    }
    assert.deepEqual(await values(), populated);
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
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND NOT attisdropped',[namespace+'.'+domain,'storage_bytes'])).rows[0].n,0,'STORAGE_BYTES_REMOVED');
      }else{
        const upgraded=await run('up',{...options,catalogue:catalogues[domain]});
        assert.deepEqual(upgraded.done,catalogues[domain].migrations.filter(m=>!before.some(row=>row.name===m.name)).map(m=>m.name));
        assert.equal((await run('check',{...options,catalogue:catalogues[domain]})).current,true);
      }
    });
  }
  for (const domain of proposal.DOMAINS) it('preserves populated '+domain+' values, seeds each tenant and refuses the older catalogue', async () => {
    const namespace = prefix+'_'+domain, catalogue = catalogues[domain];
    // The source is the immutable global-identity prefix, before the named
    // tenant-local conversion. The later shared size tail does not change
    // that historical boundary or grant the old source a tenant-local trigger.
    const conversion=catalogue.migrations.findIndex(m=>m.operation?.kind==='tenant-insertion-v1');
    assert(conversion>0,'PRECONVERSION_SOURCE_REQUIRED');
    assert.deepEqual(catalogue.migrations.slice(conversion).map(m=>m.operation || m.name),[
      {kind:'tenant-insertion-v1',domain},{kind:'tenant-insertion-binding-v1',domain},
      {kind:'identifier-array-index-v1',domain},{kind:'clinical-storage-size-v1',domain},{kind:'clinical-storage-size-removal-v1',domain},
      ...(['entries','treatments','devicestatus'].includes(domain)?['0101_'+domain+'_redundant_indexes']:[]),
      ...(domain==='devicestatus'?['0102_devicestatus_created_at_arrays',{kind:'devicestatus-sealed-days-v1',domain}]:[]),
      ...(domain==='treatments'?['0102_treatments_created_at_arrays']:[]),
      ...(domain==='entries'?['0102_entries_numeric_indexes_removed','0103_entries_follower_exceptions']:[]),
      ...(['entries','treatments'].includes(domain)?['0104_'+domain+'_clinical_time']:[])
    ],'EXACT_REVIEWED_CONVERSION_AND_SHARED_TAILS');
    const old = {...catalogue,migrations:catalogue.migrations.slice(0,conversion)};
    assert.deepEqual(old.migrations.map(m=>m.name),domain==='food'?['0001_food']:
      ['0001_'+domain,'0002_'+domain+(domain==='entries'?'_insertion_order':'_socket_order')]);
    const options = {direct:true,connectionString:uri,namespace,statementTimeoutMs:10000};
    schemas.push(namespace); await admin.query('CREATE SCHEMA '+q(namespace));
    await run('up',{...options,catalogue:old});
    const table = q(namespace)+'.'+q(domain);
    assert.notEqual((await admin.query('SELECT pg_get_serial_sequence($1,$2) AS sequence',[namespace+'.'+domain,'insertion_ordinal'])).rows[0].sequence,null,
      'OLD_SOURCE_MUST_HAVE_GLOBAL_IDENTITY_BEFORE_CONVERSION');
    for (const [tenant,id] of [[A,'a1'],[B,'b1'],[A,'a2']]) await admin.query('INSERT INTO '+table+'(tenant_id,id_kind,doc) VALUES($1,$2,$3)',[tenant,'string',{_id:id,synthetic:true}]);
    const read = async () => (await admin.query('SELECT tenant_id,id_kind,doc,insertion_ordinal::text AS ordinal FROM '+table+' ORDER BY insertion_ordinal')).rows;
    const before = await read();
    await run('up',{...options,catalogue});
    assert.deepEqual(await read(),before);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND NOT attisdropped',[namespace+'.'+domain,'storage_bytes'])).rows[0].n,0,'STORAGE_BYTES_REMOVED');
    assert.equal((await admin.query(`SELECT pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i
      WHERE i.indexrelid=to_regclass($1) AND i.indisvalid`,[namespace+'.'+domain+'_tenant_identifier_array'])).rows[0]?.predicate,
    "(jsonb_typeof((doc -> 'identifier'::text)) = 'array'::text)",'POPULATED_IDENTIFIER_ARRAY_INDEX');
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
