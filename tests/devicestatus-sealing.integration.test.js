'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { ObjectId } = require('mongodb');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const createRead = require('../lib/storage/postgres-entries-read');
const createWrite = require('../lib/storage/postgres-entries-write');
const { fromMongo } = require('../lib/storage/filter');
const readiness = require('../lib/storage/postgres-insertion-readiness');
const { grant, withTenant } = require('./fixtures/tenant-insertion-grants');
const { optInSuite } = require('./support/opt-in');
const catalogue = require('../migrations/candidates/postgres-devicestatus-socket-order-v1.json');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const options = { options: { normalize: false } };

optInSuite(!!uri, 'NS_TEST_POSTGRES_ADMIN_URI')('daily device status sealing', function () {
  this.timeout(30000);
  const ns = 'seal_' + randomBytes(6).toString('hex'), role = ns + '_app', table = ns + '.devicestatus';
  let admin, operator, conn, read, write, previousMode;
  const seal = client => client.query('SELECT '+ns+'.devicestatus_seal_day() AS n').then(r => r.rows[0].n);
  const current = (tenant, filter = {}) => scope.withTenant(tenant, () => read.findFiltered(fromMongo(filter), options));
  const mutate = (tenant, fn) => scope.withTenant(tenant, () => conn.transaction(fn));
  const stored = () => admin.query('SELECT tenant_id,id_kind,doc,insertion_ordinal FROM '+table+' ORDER BY tenant_id,insertion_ordinal').then(r=>r.rows);
  const eligible = {_id:'old',identifier:'resend', created_at:'2020-01-01T23:00:00-08:00',srvCreated:1700000000000,srvModified:1700000000001,
    unknown:{null:null,values:[null,false,0,{}]}, predictions:[1,2,3]};

  before(async function () {
    previousMode=scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin=new Client({connectionString:uri}); await admin.connect();
    operator=new Client({connectionString:uri}); await operator.connect();
    // Upgrade a populated prior catalogue in place.
    await run('up',{namespace:ns,direct:true,connectionString:uri,catalogue:{...catalogue,migrations:catalogue.migrations.slice(0,-1)}});
    await withTenant(admin,A,()=>admin.query('INSERT INTO '+table+'(tenant_id,id_kind,doc) VALUES($1,\'string\',$2)',[A,eligible]));
    await run('up',{namespace:ns,direct:true,connectionString:uri,catalogue});
    const upgraded=await admin.query('SELECT doc,received_ms FROM '+table);
    assert.deepEqual(upgraded.rows,[{doc:eligible,received_ms:null}]);
    const password=randomBytes(18).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await admin.query('GRANT USAGE ON SCHEMA '+ns+' TO '+role);
    await grant(admin,{namespace:ns,domain:'devicestatus',role,catalogue});
    const u=new URL(uri); u.username=role; u.password=password;
    conn=await connect({connectionString:u.toString(),max:3});
    read=createRead({connection:conn,table,sealedDeviceStatus:true}); write=createWrite({connection:conn,table,sealedDeviceStatus:true});
  });
  beforeEach(async function () {
    await admin.query('TRUNCATE '+ns+'.devicestatus_rows, '+ns+'.devicestatus_day, '+ns+'.tenant_insertion_ordinal');
  });
  after(async function () {
    if(conn) await conn.end();
    if(operator) await operator.end();
    if(admin) {await admin.query('DROP SCHEMA IF EXISTS '+ns+' CASCADE');await admin.query('DROP ROLE IF EXISTS '+role); await admin.end();}
    scope.setTenancyMode(previousMode);
  });

  it('publishes a complete older day atomically and retains the direct clinical window and unknown times', async function () {
    await mutate(A,async()=>{
      for(const d of [structuredClone(eligible),{...eligible,_id:new ObjectId('123456789012345678901234'),identifier:'oid'},
        {...eligible,_id:'123456789012345678901234',identifier:'text'},
        {_id:'new',created_at:new Date(Date.now()-47*3600000).toISOString(),srvCreated:1},
        {_id:'odd',created_at:['2020-01-01T00:00:00Z']}, {_id:'absent'}]) await write.insertOne(d);
    });
    await mutate(B,()=>write.insertOne({...eligible}));
    const before=await stored();
    // The patch must preserve even fields whose JSON shape is uncommon.
    await admin.query('BEGIN'); await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
    assert.equal(await seal(admin),3);
    assert.equal((await current(A)).length,6);
    // An independent observer still sees the old physical representation.
    assert.equal((await operator.query('SELECT count(*)::int n FROM '+ns+'.devicestatus_day')).rows[0].n,0);
    await admin.query('ROLLBACK');
    assert.deepEqual(await stored(),before);
    assert.equal(await withTenant(operator,A,()=>seal(operator)),3);
    assert.equal(await withTenant(operator,A,()=>seal(operator)),0);
    assert.deepEqual(await stored(),before);
    assert.deepEqual((await operator.query('SELECT "_id" FROM '+ns+'.devicestatus_rows WHERE tenant_id=$1 AND block_id IS NULL ORDER BY "_id"',[A])).rows.map(r=>r._id),['absent','new','odd']);
    assert.equal(Number((await admin.query('SELECT day_ms FROM '+ns+'.devicestatus_day')).rows[0].day_ms),Date.UTC(2020,0,2));
    assert.deepEqual(await current(A,{identifier:'resend'}),[eligible]);
    assert.deepEqual(await current(B),[eligible]);
    const history=await current(A,{srvModified:{$gt:eligible.srvModified-1}});
    assert.equal(history.length,3);
    assert(history.some(d=>d._id instanceof ObjectId)); assert(history.some(d=>d._id==='123456789012345678901234'));
    await mutate(A,()=>readiness.metadata(conn,{namespace:ns,domain:'devicestatus'}));
  });

  it('re-seals late arrivals and edits, preserves identity and ordinal, and removes deleted payloads', async function () {
    await mutate(A,()=>write.insertOne(structuredClone(eligible)));
    assert.equal(await withTenant(operator,A,()=>seal(operator)),1);
    await mutate(A,()=>write.insertOne({...eligible,_id:'late',identifier:'late'}));
    assert.equal(await withTenant(operator,A,()=>seal(operator)),1);
    await assert.rejects(mutate(A,()=>write.insertOne({...eligible,_id:'conflict'})),{code:11000});
    const before=(await stored()).find(r=>r.tenant_id===A&&r.doc._id==='old');
    await mutate(A,()=>write.updateMany(fromMongo({_id:'old'}),{set:{isValid:false,srvModified:1700000000002,unknown:{changed:true}}}));
    const after=(await stored()).find(r=>r.tenant_id===A&&r.doc._id==='old');
    assert.equal(after.insertion_ordinal,before.insertion_ordinal);
    assert.deepEqual(await current(A,{srvModified:{$gt:eligible.srvModified}}),[after.doc]);
    assert.equal(await withTenant(operator,A,()=>seal(operator)),1);
    await mutate(A,()=>write.deleteMany(fromMongo({_id:'late'})));
    assert.deepEqual(await current(A,{_id:'late'}),[]);
    const leaked=await admin.query('SELECT count(*)::int n FROM '+ns+'.devicestatus_day b, jsonb_object_keys(b.body) k WHERE NOT EXISTS(SELECT FROM '+ns+'.devicestatus_rows r WHERE r.tenant_id=b.tenant_id AND r.block_id=b.block_id AND r.insertion_ordinal::text=k)');
    assert.equal(leaked.rows[0].n,0);
  });
  it('keeps fields when a correction waits for publication of its day', async function () {
    await mutate(A,()=>write.insertOne({...eligible,_id:'race',identifier:'race'}));
    await operator.query('BEGIN');
    await operator.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
    assert.equal(await seal(operator),1);
    const corrected = mutate(A,()=>write.updateMany(fromMongo({_id:'race'}),{set:{note:'correction'}}));
    // Observe a blocked writer before publishing; both sides use the same row.
    let waiting=false;
    for(let i=0;i<100 && !waiting;i++) {
      waiting=(await admin.query('SELECT EXISTS(SELECT FROM pg_stat_activity WHERE usename=$1 AND wait_event_type=\'Lock\') AS waiting',[role])).rows[0].waiting;
      if(!waiting) await new Promise(resolve=>setTimeout(resolve,5));
    }
    await operator.query('COMMIT');
    assert.equal(waiting,true);
    assert.equal((await corrected).modifiedCount,1);
    assert.deepEqual(await current(A,{_id:'race'}),[{...eligible,_id:'race',identifier:'race',note:'correction'}]);
  });
  it('keeps the intersecting day direct and recovers a disconnected sealer without changing precise stored values', async function () {
    const cutoff = Number((await admin.query(
      'SELECT floor((extract(epoch FROM now())-172800)/86400)::bigint * 86400000 AS ms')).rows[0].ms);
    const precise = '{"_id":"precise","created_at":' + (cutoff-1) + ',"future":{"n":9007199254740993.123456789,"null":null}}';
    await withTenant(admin,A,()=>admin.query(
      'INSERT INTO '+table+"(tenant_id,id_kind,doc) VALUES ($1,'string',$2),($1,'string',$3)",[A,precise,{_id:'boundary',created_at:cutoff}]));
    const snapshot = () => admin.query('SELECT "_id",doc::text,received_ms FROM '+table+' ORDER BY "_id"').then(r=>r.rows);
    const expected = await snapshot();
    const interrupted = new Client({connectionString:uri});
    await interrupted.connect();
    try {
      await interrupted.query('BEGIN');
      await interrupted.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
      assert.equal(await seal(interrupted),1);
    } finally {
      await interrupted.end(); // Close the connection with its publication still uncommitted.
    }
    assert.deepEqual(await snapshot(),expected);
    assert.equal(await withTenant(operator,A,()=>seal(operator)),1);
    assert.deepEqual(await snapshot(),expected);
    assert.deepEqual((await admin.query('SELECT "_id" FROM '+ns+'.devicestatus_rows WHERE block_id IS NULL')).rows,[{_id:'boundary'}]);
  });

  it('exports a stable logical artifact, fences the sealer during restore and resumes with the same receipts and ordinals', async function () {
    const control=ns+'_control', owner=ns+'_owner', restorer=ns+'_restore', namespaces={devicestatus:ns};
    const key=require('../lib/tenant-registry/rules').lockKey(A);
    const maintenance=require('../lib/tenant-lifecycle/maintenance-window');
    const lifecycle=require('../lib/tenant-lifecycle').createLifecycle({catalogues:[{
      kind:'devicestatus', candidate:catalogue, tables:['tenant_insertion_ordinal','devicestatus']
    }]});
    const password=randomBytes(18).toString('hex');
    const u=new URL(uri); u.username=restorer; u.password=password;
    let pool, window, exportConn;
    try {
      await run('up',{namespace:control,direct:true,connectionString:uri,catalogue:require('../lib/tenant-lifecycle/postgres-candidate.json')});
      await admin.query('CREATE ROLE '+owner+' NOLOGIN');
      await admin.query('ALTER SCHEMA '+control+' OWNER TO '+owner);
      for (const {tablename} of (await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[control])).rows) {
        await admin.query('ALTER TABLE '+control+'.'+tablename+' OWNER TO '+owner);
      }
      await admin.query('ALTER FUNCTION '+control+'.tenant_lifecycle_backend_birth() OWNER TO '+owner);
      await admin.query(`CREATE ROLE ${restorer} LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${ns} TO ${restorer}`);
      await admin.query(`GRANT SELECT ON ${ns}.schema_migrations TO ${restorer}`);
      await grant(admin,{namespace:ns,domain:'devicestatus',role:restorer,mode:'restore',catalogue});
      for (const statement of maintenance.operatorGrants({namespace:control,role:restorer})) await admin.query(statement);
      await admin.query(`GRANT SELECT,UPDATE(phase) ON ${control}.tenant_lifecycle_key_retention TO ${restorer}`);
      await admin.query(`INSERT INTO ${control}.tenant_lifecycle_windows(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)`,[A,key]);
      await admin.query(`INSERT INTO ${control}.tenant_lifecycle_restore_authority(tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)`,[A,restorer]);
      const runSealer=()=>require('../scripts/seal-devicestatus').sealTenant({namespace:ns,lifecycleNamespace:control,tenant:A,connectionString:u.toString()});
      await mutate(A,()=>write.insertOne({...eligible,_id:'restore',identifier:'restore',srvCreated:8000000000000000}));
      const previous=(await admin.query('SELECT received_ms FROM '+table+' WHERE "_id"=$1',['restore'])).rows[0].received_ms;
      assert(Number(previous)>0 && Number(previous)<8000000000000000);
      assert.equal(await runSealer(),1);
      exportConn=await connect({connectionString:u.toString(),max:1});
      const artifact=await lifecycle.exportTenant(exportConn,{tenant:A,namespaces,sourceCommit:'8e43602ed292de993e48ee86e6ecd8ecda185667'});
      const before=await stored();
      pool=new (require('pg').Pool)({connectionString:u.toString(),max:1});
      window=maintenance.create({namespace:control,pool,locks:[{tenant:A,key}],drainTimeoutMs:8000});
      await window.withRestore(A,{artifactDigest:artifact.digest},async ({connection,maintenanceClaim})=>{
        await assert.rejects(runSealer(),{code:'LIFECYCLE_WINDOW_SUSPENDED'});
        await connection.query('DELETE FROM '+table+' WHERE tenant_id=$1',[A]);
        await connection.query('DELETE FROM '+ns+'.tenant_insertion_ordinal WHERE tenant_id=$1',[A]);
        return lifecycle.importArtifact(connection,artifact,{tenant:A,namespaces,ledgerNamespace:control,maintenanceClaim});
      });
      assert.deepEqual(await stored(),before);
      assert.equal((await admin.query('SELECT received_ms FROM '+table+' WHERE "_id"=$1',['restore'])).rows[0].received_ms,previous);
      assert.equal(await runSealer(),1);
      assert.equal(await runSealer(),0);
      assert.deepEqual(await stored(),before);
    } finally {
      if(window) await window.close();
      if(pool) await pool.end();
      if(exportConn) await exportConn.end();
      await admin.query('DROP SCHEMA IF EXISTS '+control+' CASCADE');
      await admin.query('DROP OWNED BY '+restorer);
      await admin.query('DROP ROLE IF EXISTS '+restorer+', '+owner);
    }
  });
});
