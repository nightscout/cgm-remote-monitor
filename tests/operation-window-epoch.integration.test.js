'use strict';

// covers: lib/tenant-lifecycle/operation-window.js, lib/tenant-lifecycle/operation-window-readiness.js, lib/storage/postgres-connection.js

// Restore fences and physical-backend structural admission on disposable PG,
// using the deployment catalogue/grants. The historical filename is retained for
// enabled-corpus compatibility. Warm-backend next-transaction DBA digest refusal
// is deliberately retired. Structural tamper cases below now exercise explicit
// fresh backend admission, retaining exact grant/shape/helper/ledger coverage.
// Current role/tenant/restore checks still execute on each actual transaction.
// Synthetic tenants and data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { run } = require('../lib/migrations/postgres');
const plan = require('./fixtures/multitenant-plan');
const windows = require('../lib/tenant-lifecycle/operation-window');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const readiness = require('../lib/server/serve/evaluator-consumer-readiness');
const { optInSuite } = require('./support/opt-in');

// postgres:16, pinned by digest. Override only with another digest.
const IMAGE = process.env.NS_OPERATION_WINDOW_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
// Extend the existing fixture reaper with a fixed deadline and exact ownership.
// This is test custody only; no service or application configuration uses it.
function fixtureCustody(container, image, kind, receiptPrefix) {
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {spawn,spawnSync}=require('node:child_process');
 let directory,cidfile,expectedImage,reaper,recorded=false,volumes=[],containerID,cleanupAt;
 const command=(args,env=process.env)=>execFileSync('docker',args,{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
 function absent(args,pattern){const r=spawnSync('docker',args,{encoding:'utf8',timeout:10000});if(r.error)throw r.error;if(r.status===0)return false;assert(pattern.test(r.stderr||r.stdout),'Docker error is not an absence proof');return true;}
 function inspect(){if(absent(['inspect',container],/no such (?:object|container)/i))return null;const row=JSON.parse(command(['inspect',container]))[0];assert.equal(row.Name,'/'+container);assert.equal(row.Image,expectedImage);assert.equal(row.Config.Labels['nightscout.test'],kind);assert.equal(row.Config.Labels['nightscout.test.owner'],container);assert.match(row.Id,/^[a-f0-9]{64}$/);return row;}
 function receipt(name,value){console.log(receiptPrefix.toUpperCase()+'_'+name.toUpperCase()+' '+JSON.stringify(value));if(process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY)fs.writeFileSync(path.join(process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY,receiptPrefix+'-'+name+'.json'),JSON.stringify(value),{flag:'wx',mode:0o600});}
 function capture(){const row=inspect();if(!row)return null;containerID=row.Id;volumes=row.Mounts.filter(v=>v.Type==='volume').map(v=>v.Name);if(!recorded){recorded=true;receipt('custody',{pid:process.pid,container,containerID,image,imageID:expectedImage,volumes,cleanupAt,reaperPid:reaper.pid,reaperBirth:fs.readFileSync('/proc/'+reaper.pid+'/stat','utf8').split(')').at(-1).trim().split(/\s+/)[19],cidfile});}return row;}
 async function start(password,database){
  directory=fs.mkdtempSync(path.join(os.tmpdir(),receiptPrefix+'-'));cidfile=path.join(directory,'container.cid');
  expectedImage=command(['image','inspect','--format','{{.Id}}',image]);
  const now=Math.floor(Date.now()/1000);cleanupAt=process.env.NS_OPERATION_WINDOW_FIXTURE_CLEANUP_AT===undefined?now+240:Number(process.env.NS_OPERATION_WINDOW_FIXTURE_CLEANUP_AT);assert(Number.isSafeInteger(cleanupAt)&&cleanupAt>now&&cleanupAt<=now+240,'finite fixture cleanup deadline required');
  const birth=fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(')').at(-1).trim().split(/\s+/)[19];
  const script=`set -u
: > "$4.ready"
while [ ! -f "$4.done" ] && [ "$(date +%s)" -lt "$3" ]; do
 stat=$(cat "/proc/$1/stat" 2>/dev/null) || break
 read -ra fields <<< "\${stat##*) }"
 [ "\${fields[19]:-}" = "$2" ] || break
 sleep 1
done
[ -f "$4.done" ] && exit 0
if ! row=$(docker inspect --format '{{.Id}} {{.Name}} {{.Image}} {{index .Config.Labels "nightscout.test.owner"}} {{index .Config.Labels "nightscout.test"}}' "$5" 2>"$4.error"); then
 grep -Eqi 'no such (object|container)' "$4.error" && exit 0
 exit 21
fi
read -r id name actual owner kind <<< "$row"
[[ "$id" =~ ^[a-f0-9]{64}$ ]] && [ "$name" = "/$5" ] && [ "$actual" = "$6" ] && [ "$owner" = "$5" ] && [ "$kind" = "$7" ] || exit 22
volumeList=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$id" 2>"$4.error") || exit 26
printf '%s\n' "$volumeList" > "$4.volumes"
docker rm -f -v "$id" >"$4.reaped" 2>"$4.error" || exit 23
if docker inspect "$id" > /dev/null 2>"$4.error"; then exit 24; fi
grep -Eqi 'no such (object|container)' "$4.error" || exit 25
for volume in $volumeList; do
 [[ "$volume" =~ ^[a-f0-9]{64}$ ]] || exit 27
 if docker volume inspect "$volume" > /dev/null 2>"$4.error"; then exit 28; fi
 grep -qi 'no such volume' "$4.error" || exit 29
done
`;
  reaper=spawn('bash',['-c',script,'reaper',String(process.pid),birth,String(cleanupAt),cidfile,container,expectedImage,kind],{detached:true,stdio:'ignore'});reaper.unref();
  for(let i=0;i<100&&!fs.existsSync(cidfile+'.ready');i++){assert(reaper.exitCode===null,'fixture reaper failed before creation');await new Promise(resolve=>setTimeout(resolve,10));}assert(fs.existsSync(cidfile+'.ready'),'fixture reaper armed before creation');assert(reaper.exitCode===null&&reaper.signalCode===null,'fixture reaper must remain live before creation');
  try{command(['run','--pull','never','--cidfile',cidfile,'--name',container,'--label','nightscout.test='+kind,'--label','nightscout.test.owner='+container,'-d','-p','127.0.0.1::5432','-e','POSTGRES_USER=bootstrap','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB='+database,image],{...process.env,POSTGRES_PASSWORD:password});}
  finally{capture();}
  assert(containerID,'owned container identity required');return containerID;
 }
 async function close(){
  const row=expectedImage?capture():null;
  if(row){command(['rm','-f','-v',row.Id]);assert(absent(['inspect',row.Id],/no such (?:object|container)/i));for(const volume of volumes)assert(absent(['volume','inspect',volume],/no such volume/i));receipt('cleanup',{container,containerID:row.Id,containerAbsent:true,volumes,volumesAbsent:true});}
  if(!row&&recorded){assert(absent(['inspect',containerID],/no such (?:object|container)/i));for(const volume of volumes)assert(absent(['volume','inspect',volume],/no such volume/i));receipt('cleanup',{container,containerID,containerAbsent:true,alreadyAbsent:true,volumes,volumesAbsent:true});}
  if(reaper){fs.writeFileSync(cidfile+'.done','verified cleanup\n',{mode:0o600});if(reaper.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture reaper did not drain')),3000);reaper.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('fixture reaper exit '+code));});});}
 }
 return {start,close};
}

const { A, B } = plan;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_OPERATION_WINDOW_DOCKER_TEST === '1',
  'NS_OPERATION_WINDOW_DOCKER_TEST=1')('operation-window fence and backend admission (disposable PostgreSQL, deployment grants)', function () {
  this.timeout(120000);
  const container = (process.env.NS_OPERATION_WINDOW_PG_CONTAINER_PREFIX || 'ns-window-epoch-') + crypto.randomBytes(6).toString('hex');
  const l = plan.layout('nswep'), ns = l.namespaces, q = plan.quote;
  const control = name => q(ns.control) + '.' + q(name);
  const locks = [{ tenant: A, key: '830001' }, { tenant: B, key: '830002' }];
  const urls = {};
  const custody=fixtureCustody(container,IMAGE,'operation-window-epoch','epoch');
  let previousMode, bootstrapURI, lifetimePool, window, lower, releaseWindow, suppression;

  async function asBootstrap (fn) {
    const client = new Client({ connectionString: bootstrapURI }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  const sql = text => asBootstrap(client => client.query(text));
  // One tenant data transaction (lower, api identity) and one serving operation
  // (lifetime identity) wrapping a data transaction. `called` proves the body ran.
  async function data (tenant) {
    let called = false;
    await lower.withTenant(tenant, async () => { await lower.query('SELECT 1 AS x'); called = true; });
    return called;
  }
  async function operation (tenant) {
    let called = false;
    await window.run(tenant, async () => { called = await data(tenant); });
    return called;
  }
  async function refused (fn, codes) {
    let ran = false;
    await assert.rejects(fn(() => { ran = true; }), error => codes.includes(error.code) || assert.fail('unexpected refusal ' + (error.code || error.message)));
    assert.equal(ran, false, 'body must not run');
  }
  const refuseData = (tenant, codes) => refused(mark => lower.withTenant(tenant, async () => { mark(); }), codes);
  // Warm process participation does not query SQL. Real effects still cross the
  // current lower transaction fence, including while an exclusive key is held.
  const refuseOperation = (tenant, codes) => refused(mark => window.run(tenant, () => lower.withTenant(tenant, async () => { mark(); })), codes);

  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    await custody.start(password,'nightscout_epoch_test');
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    bootstrapURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/nightscout_epoch_test';
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootstrap']); await asBootstrap(async () => {}); ready = true; }
      catch { await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    await asBootstrap(async admin => {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await admin.query('REVOKE CREATE ON DATABASE "nightscout_epoch_test" FROM PUBLIC');
      await admin.query('CREATE ROLE ' + q(l.owner) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
      for (const [kind, name] of Object.entries(l.roles)) {
        const secret = crypto.randomBytes(24).toString('hex');
        await admin.query('CREATE ROLE ' + q(name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + secret + "'");
        const url = new URL(bootstrapURI); url.username = name; url.password = secret; urls[kind] = url.toString();
      }
      for (const [kind, catalogue] of Object.entries(plan.catalogues())) {
        const namespace = ns[kind]; await admin.query('CREATE SCHEMA ' + q(namespace));
        await run('up', { direct: true, connectionString: bootstrapURI, namespace, catalogue, statementTimeoutMs: 10000 });
        for (const row of (await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1', [namespace])).rows) {
          await admin.query('ALTER TABLE ' + q(namespace) + '.' + q(row.tablename) + ' OWNER TO ' + q(l.owner));
        }
        // Every function with its own signature (the change-stamp function takes uuid[]).
        for (const row of (await admin.query('SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) {
          await admin.query('ALTER FUNCTION ' + q(namespace) + '.' + q(row.proname) + '(' + row.args + ') OWNER TO ' + q(l.owner));
        }
        await admin.query('ALTER SCHEMA ' + q(namespace) + ' OWNER TO ' + q(l.owner));
      }
      for (const statement of plan.grants(l)) await admin.query(statement);
      for (const row of locks) await admin.query('INSERT INTO ' + control('tenant_lifecycle_windows') + "(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [row.tenant, row.key]);
    });
    lifetimePool = new Pool({ connectionString: urls.lifetime_api, max: 2, options: '-c search_path=pg_catalog' });
    window = windows.create({ namespace: ns.control, locks, pool: lifetimePool });
    await window.ready();
    releaseWindow = connect.installOperationWindow(window);
    lower = await connect({ connectionString: urls.api, operationWindow: window, max: 2 });
    const calls = [];
    const reader = await connect({ connectionString: urls.suppression, operationWindow: window, max: 1,
      admitBackend: async client => {
        // Raw admitted client is the only source of the control-read exemption.
        await readiness.suppression(client, ns.alarm, {operationWindow:window});
        calls.push('evaluator-consumer-suppression-role');
      } });
    suppression = {connection:reader,calls};
  });

  after(async function () {
    try {
      try { if (lower) await lower.end(); if (suppression) await suppression.connection.end(); }
      finally { if (releaseWindow) releaseWindow(); try { if (window) await window.close(); } finally { if (lifetimePool) await lifetimePool.end(); } }
    } finally {
      scope.setTenancyMode(previousMode);
      await custody.close();
    }
  });

  it('admits data transactions and operations of an active tenant', async function () {
    assert.equal(await data(A), true);
    assert.equal(await operation(A), true);
    assert.equal(await operation(B), true);
  });

  it('refuses a tenant whose window was closed after its admission was cached; the other tenant continues', async function () {
    assert.equal(await operation(A), true, 'cached admission');
    await sql('UPDATE ' + control('tenant_lifecycle_windows') + " SET phase='suspended',generation=generation+1,claim_id='" + crypto.randomUUID() +
      "',artifact_digest='" + 'a'.repeat(64) + "' WHERE tenant_id='" + A + "'");
    try {
      await window.drainTenant(A);
      await refuseData(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      await refuseOperation(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      assert.equal(await operation(B), true);
    } finally {
      await window.invalidateTenant(A);
      await sql('UPDATE ' + control('tenant_lifecycle_windows') + " SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id='" + A + "'");
    }
    assert.equal(await operation(A), true, 'reopened window admits again');
  });

  it('refuses while the restore holds the tenant lock exclusively', async function () {
    const holder = new Client({ connectionString: bootstrapURI }); await holder.connect();
    try {
      assert.equal((await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [locks[0].key])).rows[0].held, true);
      await refuseData(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      await refuseOperation(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      assert.equal(await data(B), true);
    } finally { await holder.end(); }
    assert.equal(await data(A), true);
  });

  // Each administrator change is refused on fresh backend admission. The
  // warm-backend immediate-digest expectation is intentionally retired; native
  // DML privilege revocation and live principal checks have separate controls.
  async function freshAdmission (path) {
    if (path === 'lifetime') {
      const client = new Client({connectionString:urls.lifetime_api}); await client.connect();
      try { await require('../lib/tenant-lifecycle/operation-window-readiness').admit(client,ns.control,{lifetime:true,identity:window.identity}); }
      finally {await client.end();}
      return;
    }
    const connection = await connect({connectionString:path === 'suppression' ? urls.suppression : urls.api,
      operationWindow:window,max:1,...(path === 'suppression' ? {
        admitBackend:client => readiness.suppression(client,ns.alarm,{operationWindow:window})
      } : {})});
    await connection.end();
  }
  const birth = () => control('tenant_lifecycle_backend_birth') + '()';
  const drift = [
    ['table UPDATE on windows', 'lower', who => 'GRANT UPDATE ON ' + control('tenant_lifecycle_windows') + ' TO ' + who, who => 'REVOKE UPDATE ON ' + control('tenant_lifecycle_windows') + ' FROM ' + who],
    ['column UPDATE(phase) on windows', 'lower', who => 'GRANT UPDATE (phase) ON ' + control('tenant_lifecycle_windows') + ' TO ' + who, who => 'REVOKE UPDATE (phase) ON ' + control('tenant_lifecycle_windows') + ' FROM ' + who],
    ['row security no longer forced', 'both', () => 'ALTER TABLE ' + control('tenant_lifecycle_windows') + ' NO FORCE ROW LEVEL SECURITY', () => 'ALTER TABLE ' + control('tenant_lifecycle_windows') + ' FORCE ROW LEVEL SECURITY'],
    ['an added policy', 'both', () => 'CREATE POLICY epoch_extra ON ' + control('tenant_lifecycle_operations') + ' FOR SELECT USING (true)', () => 'DROP POLICY epoch_extra ON ' + control('tenant_lifecycle_operations')],
    ['an added trigger', 'both', () => ['CREATE FUNCTION public.epoch_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
      'CREATE TRIGGER epoch_noop BEFORE INSERT ON ' + control('tenant_lifecycle_operations') + ' FOR EACH ROW EXECUTE FUNCTION public.epoch_noop()'],
    () => ['DROP TRIGGER epoch_noop ON ' + control('tenant_lifecycle_operations'), 'DROP FUNCTION public.epoch_noop()']],
    ['an added index', 'both', () => 'CREATE INDEX epoch_phase ON ' + control('tenant_lifecycle_windows') + ' (phase)', () => 'DROP INDEX ' + q(ns.control) + '.epoch_phase'],
    ['a changed column default', 'both', () => 'ALTER TABLE ' + control('tenant_lifecycle_operations') + ' ALTER COLUMN finished SET DEFAULT true', () => 'ALTER TABLE ' + control('tenant_lifecycle_operations') + ' ALTER COLUMN finished SET DEFAULT false'],
    ['a loginable owner', 'both', () => 'ALTER ROLE ' + q(l.owner) + ' LOGIN', () => 'ALTER ROLE ' + q(l.owner) + ' NOLOGIN'],
    ['CREATE on a schema', 'lower', who => 'GRANT CREATE ON SCHEMA public TO ' + who, who => 'REVOKE CREATE ON SCHEMA public FROM ' + who],
    ['CREATE on the database', 'lower', who => 'GRANT CREATE ON DATABASE "nightscout_epoch_test" TO ' + who, who => 'REVOKE CREATE ON DATABASE "nightscout_epoch_test" FROM ' + who],
    ['membership of an elevated role', 'lower', who => ['CREATE ROLE epoch_elevated NOLOGIN CREATEDB', 'GRANT epoch_elevated TO ' + who], who => ['REVOKE epoch_elevated FROM ' + who, 'DROP ROLE epoch_elevated']],
    ['an elevated serving role', 'lower', who => 'ALTER ROLE ' + who + ' CREATEDB', who => 'ALTER ROLE ' + who + ' NOCREATEDB'],
    ['a bypassrls serving role', 'lower', who => 'ALTER ROLE ' + who + ' BYPASSRLS', who => 'ALTER ROLE ' + who + ' NOBYPASSRLS'],
    ['a changed migration ledger', 'both', () => 'INSERT INTO ' + control('schema_migrations') + " (name,checksum) VALUES ('9999_epoch_synthetic','" + '0'.repeat(64) + "')", () => 'DELETE FROM ' + control('schema_migrations') + " WHERE name='9999_epoch_synthetic'"],
    ['helper EXECUTE for a lower role', 'lower', who => 'GRANT EXECUTE ON FUNCTION ' + birth() + ' TO ' + who, who => 'REVOKE EXECUTE ON FUNCTION ' + birth() + ' FROM ' + who],
    ['a changed helper configuration', 'lifetime', () => 'ALTER FUNCTION ' + birth() + ' SET search_path = pg_catalog, public', () => 'ALTER FUNCTION ' + birth() + ' SET search_path = pg_catalog'],
    ['a foreign table write for the lifetime identity', 'lifetime', who => 'GRANT INSERT ON ' + q(ns.entries) + '.entries TO ' + who, who => 'REVOKE INSERT ON ' + q(ns.entries) + '.entries FROM ' + who],
    ['a foreign column write for the lifetime identity', 'lifetime', who => 'GRANT UPDATE (anonymous_roles) ON ' + q(ns.authorization) + '.tenant_authorization_config TO ' + who,
      who => 'REVOKE UPDATE (anonymous_roles) ON ' + q(ns.authorization) + '.tenant_authorization_config FROM ' + who],
    // Not an input of the suppression reader's guard: suppressionToo false.
    ['a foreign function executable by the lifetime identity', 'lifetime', () => 'CREATE FUNCTION public.epoch_foreign() RETURNS int LANGUAGE sql AS $$SELECT 1$$', () => 'DROP FUNCTION public.epoch_foreign()'],
    ['a replaced windows table', 'both', () => ['ALTER TABLE ' + control('tenant_lifecycle_windows') + ' RENAME TO epoch_windows_saved',
      'CREATE TABLE ' + control('tenant_lifecycle_windows') + ' (LIKE ' + q(ns.control) + '.epoch_windows_saved INCLUDING ALL)',
      // Readable by the serving identities, as a swapped-in table would need to be;
      // only its new identity (oid) differs from the admitted one.
      'GRANT SELECT ON ' + control('tenant_lifecycle_windows') + ' TO ' + [l.roles.api, l.roles.lifetime_api, l.roles.suppression].map(q).join(',')],
    () => ['DROP TABLE ' + control('tenant_lifecycle_windows'), 'ALTER TABLE ' + q(ns.control) + '.epoch_windows_saved RENAME TO tenant_lifecycle_windows']]
  ];
  const statements = (value, who) => [].concat(value(who));
  const roleFor = path => q(path === 'lifetime' ? l.roles.lifetime_api : l.roles.api);
  for (const [label, path, change, revert] of drift) {
    it('fresh backend admission refuses ' + label + ', and admits after the revert', async function () {
      assert.equal(await operation(A), true, 'cached admission before the change');
      for (const text of statements(change, roleFor(path))) await sql(text);
      try {
        const codes = ['LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'LIFECYCLE_WINDOW_ROLE_UNSAFE'];
        if (path !== 'lifetime') await assert.rejects(freshAdmission('lower'), error => codes.includes(error.code));
        if (path !== 'lower') await assert.rejects(freshAdmission('lifetime'), error => codes.includes(error.code));
      } finally { for (const text of statements(revert, roleFor(path))) await sql(text); }
      if (path !== 'lifetime') await freshAdmission('lower');
      if (path !== 'lower') await freshAdmission('lifetime');
      assert.equal(await operation(A), true, 'healthy existing operation after the revert');
    });
  }

  // Suppression admission now runs in the constructor-only raw backend
  // callback. Existing snapshots do not reconstruct global catalogue hashes.
  const suppressionCases = [...drift.filter(([label]) => label !== 'a foreign function executable by the lifetime identity'),
    ['a foreign table read for the suppression identity', 'suppression', who => 'GRANT SELECT ON ' + q(ns.entries) + '.entries TO ' + who, who => 'REVOKE SELECT ON ' + q(ns.entries) + '.entries FROM ' + who],
    ['a changed suppression policy', 'suppression', () => 'CREATE POLICY epoch_extra ON ' + q(ns.alarm) + '.tenant_alarm_suppression FOR SELECT USING (true)', () => 'DROP POLICY epoch_extra ON ' + q(ns.alarm) + '.tenant_alarm_suppression'],
    ['a changed suppression ledger', 'suppression', () => 'INSERT INTO ' + q(ns.alarm) + ".schema_migrations (name,checksum) VALUES ('9999_epoch_synthetic','" + '0'.repeat(64) + "')", () => 'DELETE FROM ' + q(ns.alarm) + ".schema_migrations WHERE name='9999_epoch_synthetic'"]];
  const snapshot = () => scope.withTenant(A, () => suppression.connection.snapshotTransaction(() => suppression.connection.query('SELECT * FROM '+q(ns.alarm)+'.tenant_alarm_suppression')));
  const fullChecks = () => suppression.calls.filter(text => text.includes('evaluator-consumer-suppression-role')).length;
  it('suppression warm snapshots skip structural re-admission', async function () {
    await snapshot(); const before = fullChecks();
    await snapshot(); await snapshot();
    assert.equal(fullChecks(), before);
  });
  for (const [label, , change, revert] of suppressionCases) {
    it('suppression fresh backend admission refuses ' + label.replace('the lifetime identity', 'the suppression identity') + ', and admits again after the revert', async function () {
      await snapshot();
      const who = q(l.roles.suppression);
      for (const text of statements(change, who)) await sql(text);
      try {
        await assert.rejects(freshAdmission('suppression'), error => ['EVALUATOR_CONSUMER_READINESS_REFUSED', 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'LIFECYCLE_WINDOW_ROLE_UNSAFE'].includes(error.code || error.message) ||
          assert.fail('unexpected refusal ' + (error.code || error.message)));
      } finally { for (const text of statements(revert, who)) await sql(text); }
      await freshAdmission('suppression'); await snapshot();
    });
  }

  it('documents the warm DBA-drift boundary and rejects the same expansion on fresh admission', async function () {
    await data(A);
    await sql('GRANT UPDATE ON '+control('tenant_lifecycle_windows')+' TO '+q(l.roles.api));
    try {
      assert.equal(await data(A),true,'warm backend has no broad next-transaction catalogue proof');
      await assert.rejects(freshAdmission('lower'),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    } finally {await sql('REVOKE UPDATE ON '+control('tenant_lifecycle_windows')+' FROM '+q(l.roles.api));}
    await freshAdmission('lower');
  });
  // The census observes a reconnect as a different physical backend.
  it('re-reads the backend identity after a reconnect to a different backend', async function () {
    const before = connect.cohortBackends(window).map(row => row.pid);
    assert.equal(await data(A), true);
    const pids = (await asBootstrap(client => client.query("SELECT pid FROM pg_stat_activity WHERE usename=$1", [l.roles.api]))).rows.map(row => row.pid);
    assert.ok(pids.length >= 1);
    await asBootstrap(client => client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1', [l.roles.api]));
    await new Promise(resolve => setTimeout(resolve, 200));
    for (let i = 0; i < 3; i++) { try { if (await data(A)) break; } catch { /* the terminated client is discarded on its first use */ } }
    assert.equal(await data(A), true);
    const after = connect.cohortBackends(window).map(row => row.pid);
    const fresh = (await asBootstrap(client => client.query("SELECT pid FROM pg_stat_activity WHERE usename=$1", [l.roles.api]))).rows.map(row => row.pid);
    assert.ok(fresh.some(pid => !before.includes(pid) && after.includes(pid)), 'the new backend is in the census');
  });
});
