'use strict';

// Synthetic native witness. Disabled discovery starts no actors. Enabled runs
// require the coordinator's exact joined SOURCE commit before Docker starts.
// Participant peers report real database backends and actual catalogue OIDs;
// the production census, maintenance controller and branded claim are unchanged.
// covers: lib/tenant-lifecycle/recommission.js, lib/tenant-lifecycle/deletion-maintenance.js, lib/tenant-lifecycle/recommission-grants.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Client, Pool } = require('pg');
const scope = require('../../lib/storage/tenant-scope');
const artifacts = require('../../lib/tenant-lifecycle/artifact');
const lifecycle = require('../../lib/tenant-lifecycle');
const maintenance = require('../../lib/tenant-lifecycle/maintenance-window');
const cohorts = require('../../lib/server/serve/operation-cohort');
const manifests = require('../../lib/server/serve/operation-cohort-manifest');
const transport = require('../../lib/server/internal-api/transport');
const contracts = require('../../lib/server/internal-api/contracts');
const datastore = require('../../lib/storage/postgres-datastore');
const rules = require('../../lib/tenant-registry/rules');
const clinical = require('../../lib/tenant-lifecycle/clinical-catalogue').CLINICAL;
const ordered = ['entries', 'treatments', 'devicestatus', 'profile', 'food'];
const { optInSuite } = require('../support/opt-in');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ROOT = path.resolve(__dirname, '../..');
const PG_IMAGE = 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const VAULT_IMAGE = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const DAY = 86400000, BASE = 1800000000000;
const q = value => '"' + value + '"';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready (probe) {
  let last;
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    try { return await probe(); } catch (error) { last = error; await sleep(200); }
  }
  throw last;
}

module.exports = function registerRecommission ({native=false}={}) {
optInSuite(process.env.NS_TENANT_RECOMMISSION_PG_VAULT_TEST === '1',
  'NS_TENANT_RECOMMISSION_PG_VAULT_TEST=1 and NS_TENANT_RECOMMISSION_SOURCE_COMMIT=<exact joined HEAD>')(
  (native ? 'maintained native source ' : '') + 'exact deletion artifact recommission (native PostgreSQL RLS and Vault)', function () {
    this.timeout(180000);
    const id = crypto.randomBytes(5).toString('hex'), prefix = (native?'nrc_':'rc_') + id;
    const selectionOptions = () => native ? {nativeSelection:profile} : {intakeProfile:profile};
    const owner = prefix + '_owner', role = prefix + '_maintenance';
    const peerRole = prefix + '_peer', assignmentRole = prefix + '_assignment', intakeRole = prefix + '_intake';
    let previousMode, sourceCommit, adminURI, roleURI, pool, controller, cohort, life, admission, profile, bindings, ns, registryNamespace;
    let artifactDirectory, socketDirectory, vault, runtimeToken, custodianToken, ownerURI, participantEntries, configMissing = false;
    const containers = [], peers = [], backends = [], roots = new Map();
    const table = (kind, name) => q(ns[kind]) + '.' + q(name);
    const keysOf = tenant => Object.keys(rules.PURPOSES).map(purpose => ({ mount: 'transit', name: rules.vaultKey(tenant, purpose) }));
    const locks = [A, B].map(tenant => ({ tenant, key: rules.lockKey(tenant) }));
    async function admin (fn) {
      const client = new Client({ connectionString: adminURI }); await client.connect();
      try { return await fn(client); } finally { await client.end(); }
    }
    // The ordinary ceremony/export port owns only a transaction-local backend.
    // It is closed before the controller census, not left as an unregistered
    // clinical actor while executeDeletionWithMaintenance acquires its backend.
    let ordinaryClient;
    const port = {
      query: (sql, values) => ordinaryClient.query(sql, values),
      transaction: fn => ordinaryTransaction(fn, false),
      snapshotTransaction: fn => ordinaryTransaction(fn, true)
    };
    async function ordinaryTransaction (fn, snapshot) {
      assert.equal(ordinaryClient, undefined);
      const client = ordinaryClient = new Client({ connectionString: roleURI }); await client.connect();
      try {
        await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [scope.currentTenant()]);
        const result = await fn(); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { ordinaryClient = undefined; await client.end(); }
    }
    async function vaultRequest (name, body, token = vault.token) {
      const response = await fetch(vault.address + 'v1/' + name, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('RECOMMISSION_FIXTURE_VAULT_REFUSED'); }
      return response.status === 204 ? null : response.json();
    }
    function provider (tenant) {
      return require('../../lib/secrets/vault-transit').createVaultTransit({ address: vault.address, mount: 'transit', allowInsecureLoopback: true,
        timeoutMs: 5000, getToken: async () => runtimeToken, encryptionKey: rules.vaultKey(tenant, 'data'),
        signingKey: rules.vaultKey(tenant, 'signing'), signingVersion: 1 });
    }
    const replay = () => ({ consumer: profile.binding.consumer, projectionVersion: 'native-recommission-v1',
      checkpointTable: (native?ns.evaluator_checkpoint:ns.checkpoint) + '.tenant_consumer_checkpoint', clockTable: ns.clock + '.tenant_write_clock',
      domains: Object.fromEntries(clinical.map(kind => [kind, ns[kind] + '.' + kind])), pageSize: 100, maxRows: 1000 });
    const replays=()=>native?[replay(),{...replay(),consumer:'realtime-native-recommission',checkpointTable:ns.checkpoint+'.tenant_consumer_checkpoint'}]:[replay()];
    async function currentConfiguration ({ tenant, connection }) {
      if (configMissing) return undefined;
      const keys = (await connection.query('SELECT purpose,kid,public_key FROM ' + q(registryNamespace) + '.tenant_registry_keys WHERE tenant_id=$1', [tenant])).rows;
      const human = require('../../lib/tenant-registry/provision').HUMAN_KIDS;
      const current = new Set(['access:key1', 'management:management1', 'human-data:' + human.data, 'human-management:' + human.management]);
      const selected = keys.filter(key => current.has(key.purpose + ':' + key.kid));
      assert.equal(selected.length, 4, 'explicit current key IDs must all exist');
      const grants = [{ principal: 'runtime', consumer: 'api', operation: 'decrypt', id: 'root' }];
      return { hosts: [tenant === A ? 'one.example.test' : 'two.example.test'], actor: { principal: role, consumer: 'recommission' }, eventTime: BASE + 500,
        ownerCatalogue: ['*'], ownerActors: [{ principal: 'subject_a', consumer: 'native_owner', active: true, canUpdate: true, delegable: ['api:*:read'] }],
        ownerConfiguration: [{ principal: 'subject_a', consumer: 'native_owner', active: true, canConfigure: true }],
        operatorPolicy: { deployment: {}, overrides: {} }, subjectPolicy: { grants, code: grants, operator: grants },
        access: { active: true, keys: selected.map(key => ({ purpose: key.purpose, kid: key.kid, publicKey: key.public_key })) }, replays: replays(), ...(native?{nativeSource:{source:profile.binding.source,generation:profile.binding.generation}}:{}) };
    }
    async function snapshot (tenant) {
      return admin(async client => {
        const rows = {};
        for (const entry of admission.catalogues) for (const name of entry.tables) {
          rows[entry.kind + '.' + name] = artifacts.digestRows((await client.query('SELECT * FROM ' + q(entry.namespace) + '.' + q(name) + ' WHERE tenant_id=$1', [tenant])).rows);
        }
        for (const name of ['tenant_registry', 'tenant_registry_hosts', 'tenant_registry_keys']) rows['registry.' + name] = artifacts.digestRows((await client.query('SELECT * FROM ' + q(registryNamespace) + '.' + q(name) + ' WHERE tenant_id=$1', [tenant])).rows);
        return rows;
      });
    }
    async function logicalControllerFor (tenant) {
      const logicalRole=prefix+'_logical_'+crypto.randomBytes(2).toString('hex'),password=crypto.randomBytes(24).toString('hex');
      await admin(async client=>{
        await client.query('CREATE ROLE '+q(logicalRole)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '"+password+"'");
        for(const entry of admission.catalogues){
          await client.query('GRANT USAGE ON SCHEMA '+q(entry.namespace)+' TO '+q(logicalRole));
          await client.query('GRANT SELECT ON '+q(entry.namespace)+'.schema_migrations TO '+q(logicalRole));
          for(const name of entry.tables)await client.query('GRANT SELECT ON '+q(entry.namespace)+'.'+q(name)+' TO '+q(logicalRole));
        }
        for(const kind of clinical)for(const sql of require('../../lib/server/ordinary-deployment-grants').insertionGrants({namespace:ns[kind],domain:kind,role:logicalRole,mode:'restore'}))await client.query(sql);
        await client.query('GRANT UPDATE(last_stamp) ON '+table('clock','tenant_write_clock')+' TO '+q(logicalRole));
        for(const sql of maintenance.operatorGrants({namespace:ns.lifecycle,role:logicalRole,nativeSelection:profile}))await client.query(sql);
        await client.query('GRANT UPDATE(phase,restored_at) ON '+table('lifecycle','tenant_lifecycle_key_retention')+' TO '+q(logicalRole));
        await client.query('GRANT USAGE ON SCHEMA '+q(registryNamespace)+' TO '+q(logicalRole));
        await client.query('GRANT SELECT ON '+q(registryNamespace)+'.tenant_registry_keys TO '+q(logicalRole));
        await client.query('GRANT pg_read_all_stats TO '+q(logicalRole));
        await client.query('INSERT INTO '+table('lifecycle','tenant_lifecycle_restore_authority')+' (tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)',[tenant,logicalRole]);
      });
      const url=new URL(adminURI);url.username=logicalRole;url.password=password;
      const logicalPool=new Pool({connectionString:url.toString(),max:1}),logicalController=maintenance.create({namespace:ns.lifecycle,locks,pool:logicalPool,cohort,drainTimeoutMs:10000,nativeSelection:profile});
      return {logicalPool,logicalController};
    }
    async function resumeFailedClaim () {
      const recovery = require('../../lib/tenant-lifecycle/restore-resume').create({ namespace: ns.lifecycle, locks, pool, cohort, ...selectionOptions() });
      try {
        const inspection = await recovery.inspect(A);
        assert.equal(inspection.phase, 'suspended'); assert.equal(inspection.resumable, true);
        await recovery.resume(A, { claimId: inspection.claimId });
      } finally { await recovery.close(); }
    }
    async function reconstruct (record, options = {}) {
      return controller.withRestore(A, { artifactDigest: record.artifact.digest }, ({ connection, maintenanceClaim }) =>
        life.recommission(connection, record.artifact, { tenant: A, namespaces: ns, ledgerNamespace: ns.lifecycle,
          requestId: record.requestId, maintenanceClaim, now: () => record.at + 1000, ...options }));
    }
    async function refusedRestore (record, expected, options) {
      const before = await snapshot(B);
      await assert.rejects(reconstruct(record, options), expected);
      assert.deepEqual(await snapshot(B), before);
      await resumeFailedClaim();
    }
    async function erase (at) {
      const artifact = await life.exportTenant(port, { tenant: A, namespaces: ns, sourceCommit, now: () => at - 10 });
      await lifecycle.saveTenantArtifact(artifact, { directory: artifactDirectory });
      const options = { tenant: A, namespaces: ns, ledgerNamespace: ns.lifecycle, artifact, now: () => at };
      const request = await life.requestDeletion(port, options);
      await life.confirmDeletion(port, { ...options, requestId: request.requestId });
      const result = await life.executeDeletionWithMaintenance(port, { ...options, requestId: request.requestId, controller });
      assert(result.result.total > 0, 'real DATA erasure deleted nonempty rows');
      await admin(async client => {
        for (const entry of life.CATALOGUE) for (const name of entry.tables) {
          const rows = (await client.query('SELECT count(*)::int AS n FROM ' + q(ns[entry.kind]) + '.' + q(name) + ' WHERE tenant_id=$1', [A])).rows;
          assert.equal(rows[0].n, 0, 'executed deletion removed ' + entry.kind + '.' + name);
        }
        const retained = (await client.query('SELECT phase,artifact_digest,retain_until FROM ' + table('lifecycle', 'tenant_lifecycle_key_retention') + ' WHERE request_id=$1', [request.requestId])).rows[0];
        assert.equal(retained.phase, 'retained'); assert.equal(retained.artifact_digest, artifact.digest);
        if(native){const activity=(await client.query('SELECT suspended,deletion_request_id FROM '+table('lifecycle','tenant_activity')+' WHERE tenant_id=$1',[A])).rows[0];assert.equal(activity.suspended,true,'NATIVE_ERASURE_MUST_STAY_SUSPENDED');assert.equal(activity.deletion_request_id,request.requestId);}
      });
      return { artifact, requestId: request.requestId, at };
    }

    before(async function () {
      sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      assert.match(process.env.NS_TENANT_RECOMMISSION_SOURCE_COMMIT || '', /^[a-f0-9]{40}$/);
      assert.equal(sourceCommit, process.env.NS_TENANT_RECOMMISSION_SOURCE_COMMIT, 'coordinator must bind this exact joined SOURCE before resources start');
      assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim(), '', 'native SOURCE has no tracked edits');
      previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
      artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-recommission-artifacts-'));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Suite-owned mkdtemp path.
      fs.chmodSync(artifactDirectory, 0o700);
      const createdSockets = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-rc-ipc-'));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Suite-owned mkdtemp path.
      socketDirectory = fs.realpathSync(createdSockets);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Suite-owned canonical mkdtemp path.
      fs.chmodSync(socketDirectory, 0o700);
      const pgPassword = crypto.randomBytes(24).toString('hex'), vaultToken = crypto.randomBytes(24).toString('hex');
      for (const [name, image, args, env] of [
        [prefix + '_pg', PG_IMAGE, ['-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=nightscout_recommission_test'], { POSTGRES_PASSWORD: pgPassword }],
        [prefix + '_vault', VAULT_IMAGE, ['-e', 'VAULT_DEV_ROOT_TOKEN_ID'], { VAULT_DEV_ROOT_TOKEN_ID: vaultToken }]
      ]) {
        const isVault = image === VAULT_IMAGE;
        const container = execFileSync('docker', ['run', '--name', name, '--label', 'nightscout.test=tenant-recommission', '--label', 'org.nightscout.test.owner=' + prefix,
          '-d',...(native?['--memory','768m','--cpus','1','--pids-limit','192']:[]), '-p', '127.0.0.1::' + (isVault ? '8200' : '5432'), ...args, image, ...(isVault ? ['server', '-dev'] : ['-c','wal_level=logical','-c','max_replication_slots=16'])],
        { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
        assert.match(container, /^[a-f0-9]{64}$/); containers.push(container);
        console.log('NATIVE_RECOMMISSION_RESOURCE '+JSON.stringify({id:container,name,image,owner:prefix}));
        spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), container], { detached: true, stdio: 'ignore' }).unref();
      }
      adminURI = 'postgres://bootstrap:' + pgPassword + '@127.0.0.1:' + docker(['port', containers[0], '5432/tcp']).split(':').pop() + '/nightscout_recommission_test';
      vault = { address: 'http://127.0.0.1:' + docker(['port', containers[1], '8200/tcp']).split(':').pop() + '/', token: vaultToken };
      await ready(() => admin(async () => {})); await ready(() => vaultRequest('sys/health'));
      const kinds = [...lifecycle.admittedCatalogue().map(entry => entry.kind), 'lifecycle', 'alarm_suppression', 'notification_outbox',...(native?['evaluator_checkpoint']:[])];
      ns = Object.fromEntries(kinds.map(kind => [kind, prefix + '_' + kind]));
      profile = native ? await admin(async client=>{
        const slot='nrc_'+id;await client.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')",[slot]);
        const row=(await client.query('SELECT s.system_identifier::text AS system_id,c.timeline_id::integer AS timeline,current_database() AS database FROM pg_control_system() s CROSS JOIN pg_control_checkpoint() c')).rows[0];
        return require('../../lib/tenant-lifecycle/native-selection').create({namespace:ns.evaluator_checkpoint,lifecycleNamespace:ns.lifecycle,consumer:'evaluator-native-recommission',source:{...row,slot},generation:'native-recommission-v1'});
      }) : require('../../lib/pgstream/pool-intake-profile').create({ namespace: ns.checkpoint, membershipNamespace: prefix + '_membership',
        lifecycleNamespace: ns.lifecycle, role: intakeRole, operatorRole: assignmentRole, consumer: 'evaluator-native-recommission',
        codec: require('../../lib/pgstream/pool-intake-profile').CODEC, generationDomain: require('../../lib/pgstream/pool-intake-profile').GENERATION_DOMAIN,
        sliceRule: require('../../lib/pool-membership/slice').RULE });
      bindings = native ? [{namespace:ns.notification_outbox,consumer:'synthetic_realtime'}] : [{ namespace: ns.notification_outbox, checkpointNamespace: ns.checkpoint, membershipNamespace: profile.binding.membershipNamespace,
        lifecycleNamespace: ns.lifecycle, consumer: 'synthetic_realtime', evaluatorConsumer: profile.binding.consumer + '-completed' }];
      const alarm = require('./tenant-deployment-alarm').alarmInputs({ tenants: [A, B], now: BASE, writerRole: prefix + '_alarm', readerRole: prefix + '_alarm_reader' });
      const outbox = require('./tenant-deployment-notifications').notificationInputs({ tenants: [A, B], now: BASE,
        outboxRole: prefix + '_outbox', checkpointWriterRole: prefix + '_checkpoint_writer', ackReaderRole: prefix + '_ack_reader' });
      const admissionOptions={ namespaces: ns, ...selectionOptions(), notificationBindings: bindings,
        selection: {...Object.fromEntries(['treatments', 'devicestatus', 'profile'].map(kind => [kind, 'migrations/candidates/postgres-' + kind + '-socket-order-v1.json'])),...(native?{checkpoint:'migrations/candidates/postgres-realtime-output-v2.json',evaluator_checkpoint:'migrations/candidates/postgres-evaluator-work-v2.json'}:{})}, extensions: [alarm.extension, outbox.extension],...(native?{instances:[{kind:'evaluator_checkpoint',of:'checkpoint'}]}:{}) };
      admission=require('../../lib/tenant-operations/catalogues').deploymentAdmission(admissionOptions);
      if(native)assert.throws(()=>require('../../lib/tenant-operations/catalogues').deploymentAdmission({...admissionOptions,selection:{...admissionOptions.selection,evaluator_checkpoint:'migrations/candidates/postgres-realtime-output-v2.json'}}),{message:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
      const rolePassword = crypto.randomBytes(24).toString('hex'), peerPassword = crypto.randomBytes(24).toString('hex');
      const url = new URL(adminURI); url.username = role; url.password = rolePassword; roleURI = url.toString();
      let peerURI, identity;
      await admin(async client => {
        await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); await client.query('REVOKE CREATE ON DATABASE nightscout_recommission_test FROM PUBLIC');
        await client.query('CREATE ROLE ' + q(owner) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION');
        for (const [name, password] of [[role, rolePassword], [peerRole, peerPassword]]) await client.query('CREATE ROLE ' + q(name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '" + password + "'");
        for (const name of [intakeRole, assignmentRole]) await client.query('CREATE ROLE ' + q(name) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
        const migrations = [...(native?[]:[{ namespace: profile.binding.membershipNamespace, catalogue: require('../../lib/pool-membership/pool-candidate').build() }]),
          ...admission.catalogues.slice().sort((a, b) => Number(b.kind === 'lifecycle') - Number(a.kind === 'lifecycle'))];
        for (const entry of migrations) {
          await client.query('CREATE SCHEMA ' + q(entry.namespace));
          await require('../../lib/migrations/postgres').run('up', { direct: true, connectionString: adminURI, namespace: entry.namespace, catalogue: entry.catalogue });
          for (const row of (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [entry.namespace])).rows) await client.query('ALTER TABLE ' + q(entry.namespace) + '.' + q(row.tablename) + ' OWNER TO ' + q(owner));
          for (const row of (await client.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [entry.namespace])).rows) await client.query('ALTER FUNCTION ' + row.signature + ' OWNER TO ' + q(owner));
          await client.query('ALTER SCHEMA ' + q(entry.namespace) + ' OWNER TO ' + q(owner));
        }
        // Current pool mutations require a transaction-local cohort lock,
        // including fixture initialization. The unlocked attempt is the control.
        if(!native){
        const desiredSQL = 'INSERT INTO ' + q(profile.binding.membershipNamespace) + ".pool_desired(pool_kind,members,slice_rule,revision,updated_at,partitioned) VALUES ('evaluator',1,$1,1,clock_timestamp(),false)";
        const desiredValues = [require('../../lib/pool-membership/slice').RULE];
        await assert.rejects(client.query(desiredSQL, desiredValues), /POOL_MUTATION_PROTOCOL_REQUIRED/);
        await client.query('BEGIN');
        try {
          await require('../../lib/pool-membership/transaction-lock').lock(client.query.bind(client), profile.binding.membershipNamespace, 'evaluator');
          await client.query(desiredSQL, desiredValues);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        }
        const lab = await require('./provisioned-tenants').create({ admin: client, adminURI, owner, vault,
          namespaces: { ...Object.fromEntries(['authorization', 'secrets', 'legacy', 'access', 'clock'].map(kind => [kind, ns[kind]])),
            control: ns.lifecycle, settings: ns.tenant_settings, operatorPolicy: ns.operator_policy },
          checkpoints: replays().map(input=>({namespace:input.checkpointTable.split('.')[0],consumer:input.consumer,digest:require('../../lib/storage/postgres-durable-replay')({...input,connection:{query(){},snapshotTransaction(){}}}).digest})) });
        for (const tenant of [A, B]) roots.set(tenant, (await lab.provision({ id: tenant, hosts: [tenant === A ? 'one.example.test' : 'two.example.test'], issueRootSecret: true })).rootSecret);
        registryNamespace = lab.namespaces.registry;
        await lab.release(); // suite-owned Vault deliberately remains running.
        for (const sql of require('../../lib/tenant-lifecycle/recommission-grants').build({ catalogues: admission.catalogues, namespaces: ns,
          registryNamespace, ...selectionOptions(), role, destroyRetainedKeys: true })) await client.query(sql);
        // The existing ordinary maintenance census requires real backend births.
        await client.query('GRANT pg_read_all_stats TO ' + q(role));
        await client.query('INSERT INTO ' + table('lifecycle', 'tenant_lifecycle_restore_authority') + '(tenant_id,role_oid,active) VALUES($1,$3::regrole::oid,true),($2,$3::regrole::oid,true)', [A, B, role]);
        for (const kind of clinical) { await client.query('GRANT USAGE ON SCHEMA ' + q(ns[kind]) + ' TO ' + q(peerRole)); await client.query('GRANT SELECT ON ' + table(kind, kind) + ' TO ' + q(peerRole)); }
        for (const sql of require('../../lib/server/ordinary-deployment-grants').ownerGrants({ namespaces: ns, roles: { owner_writer: peerRole, owner_reader: peerRole } })) await client.query(sql);
        const peerURL = new URL(adminURI); peerURL.username = peerRole; peerURL.password = peerPassword; peerURI = peerURL.toString();
        ownerURI = peerURI;
        for (const tenant of [A, B]) {
          await client.query("SELECT set_config('app.current_tenant_id',$1,false)", [tenant]);
          const historical = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
          await client.query('INSERT INTO ' + q(registryNamespace) + ".tenant_registry_keys(tenant_id,purpose,kid,public_key) VALUES($1,'access','historical_access',$2)", [tenant, historical]);
          await client.query('INSERT INTO ' + table('access', 'access_keys') + "(tenant_id,kid,purpose,active) VALUES($1,'historical_access','data',false)", [tenant]);
          const prepared = require('../../lib/secrets/legacy-verifiers').prepare(Buffer.from(roots.get(tenant)), [{ subjectId: 'subject_a', tokenPrefix: 'a' }]);
          await client.query('UPDATE ' + table('legacy', 'legacy_credential_config') + ' SET root_verifiers=$2,verifier_root_reference_id=root_reference_id WHERE tenant_id=$1', [tenant, prepared.rootVerifiers]);
          await client.query('INSERT INTO ' + table('authorization', 'tenant_authorization_subjects') + "(tenant_id,subject_id,display_name) VALUES($1,'subject_a','Synthetic owner')", [tenant]);
          await client.query('INSERT INTO ' + table('legacy', 'legacy_credential_subjects') + "(tenant_id,subject_id,token_prefix,verifier_token_prefix,verifiers) VALUES($1,'subject_a','a','a',$2)", [tenant, prepared.subjects[0].verifiers]);
          await client.query('INSERT INTO ' + table('authorization', 'tenant_owner_actors') + "(tenant_id,principal,consumer,active,can_update,delegable) VALUES($1,'archived_owner','native_owner',true,true,ARRAY['*'])", [tenant]);
          await client.query('INSERT INTO ' + table('owner_configuration', 'tenant_owner_configuration_authority') + "(tenant_id,principal,consumer,active,can_configure) VALUES($1,'archived_owner','native_owner',true,true)", [tenant]);
          await client.query('INSERT INTO ' + table('subject_policy', 'subject_policy') + '(tenant_id,version,grants) VALUES($1,7,$2)', [tenant, JSON.stringify([{ principal: 'archived_owner', consumer: 'old_api', operation: 'decrypt', id: 'root' }])]);
          for (const version of [2, 7]) await client.query('INSERT INTO ' + table('subject_policy', 'subject_policy_audit') + "(event_id,tenant_id,principal,consumer,operation,phase,event_time,version) VALUES($1,$2,'archived_owner','old_api','policy-replace','committed',$3,$4)", [crypto.randomUUID(), tenant, BASE - 1000, version]);
          await client.query('INSERT INTO ' + table('access', 'access_credentials') + "(tenant_id,credential_id,subject_id,generation,enabled) VALUES($1,'credential_a','subject_a',7,true)", [tenant]);
          await client.query('INSERT INTO ' + table('access', 'access_sessions') + "(tenant_id,session_id,subject_id,credential_id,generation,expires_at,active,purpose) VALUES($1,'old_session','subject_a','credential_a',7,$2,true,'data')", [tenant, BASE + DAY]);
          await client.query('INSERT INTO ' + table('human_session', 'human_identities') + "(tenant_id,issuer,provider_subject,subject_id,credential_id,enabled,generation,purposes) VALUES($1,'https://synthetic.invalid','provider_a','subject_a','credential_a',true,7,ARRAY['data'])", [tenant]);
          await client.query('INSERT INTO ' + table('human_session', 'human_sessions') + "(tenant_id,session_id,subject_id,purpose,issuer,provider_subject,provider_session,authenticated_at,created_at,active,authority_generation,credential_generation) VALUES($1,'old_human','subject_a','data','https://synthetic.invalid','provider_a','provider_session',1000,1000,true,7,7)", [tenant]);
          await client.query('INSERT INTO ' + table('human_session', 'human_access_tokens') + '(tenant_id,token_hash,session_id,expires_at) VALUES($1,$2,\'old_human\',2000)', [tenant, 'a'.repeat(64)]);
          await client.query('INSERT INTO ' + table('human_session', 'human_logout_events') + "(tenant_id,issuer,event_id,issued_at) VALUES($1,'https://synthetic.invalid','historical_logout',1000)", [tenant]);
          await client.query('UPDATE ' + table('clock', 'tenant_write_clock') + ' SET last_stamp=$2,last_delete_stamp=$3 WHERE tenant_id=$1', [tenant, String(BASE), String(BASE - 100)]);
          for (const kind of clinical) for (const number of ordered.includes(kind) ? [2, 1, 99] : [2, 1]) {
            const doc = { _id: kind + '-' + number, identifier: kind + '-' + number, value: number, type: kind === 'entries' ? 'sgv' : kind, created_at: '2027-01-15T08:00:00.000Z', nested: { preserve: [0, false, null] },
              ...(kind === 'activity' ? {} : { srvCreated: BASE - 500, srvModified: BASE - 100 }) };
            await client.query('INSERT INTO ' + table(kind, kind) + '(tenant_id,id_kind,doc) VALUES($1,\'string\',$2)', [tenant, JSON.stringify(doc)]);
            if (number === 99) await client.query('DELETE FROM ' + table(kind, kind) + ' WHERE tenant_id=$1 AND "_id"=$2', [tenant, kind + '-99']);
          }
        }
        for (const row of alarm.rows.tenant_alarm_suppression) await client.query('INSERT INTO ' + table('alarm_suppression', 'tenant_alarm_suppression') + '(tenant_id,alarm_group,alarm_level,acked_at,expires_at) VALUES($1,$2,$3,$4,$5)', Object.values(row));
      });
      // The current serving token cannot create, rotate or destroy provider keys.
      await vaultRequest('sys/policies/acl/native-recommission-runtime', { policy: [A, B].flatMap(tenant => [
        ...['encrypt', 'decrypt'].map(verb => 'path "transit/' + verb + '/' + rules.vaultKey(tenant, 'data') + '" { capabilities=["update"] }'),
        ...['hmac', 'verify'].map(verb => 'path "transit/' + verb + '/' + rules.vaultKey(tenant, 'signing') + '" { capabilities=["update"] }'),
        ...['access', 'management', 'human-data', 'human-management'].map(purpose => 'path "transit/sign/' + rules.vaultKey(tenant, purpose) + '" { capabilities=["update"] }')
      ]).join('\n') });
      runtimeToken = (await vaultRequest('auth/token/create', { policies: ['native-recommission-runtime'], no_default_policy: true, ttl: '1h' })).auth.client_token;
      await vaultRequest('sys/policies/acl/native-recommission-custodian', { policy: keysOf(A).map(key => 'path "transit/keys/' + key.name + '" { capabilities=["read","delete"] }\npath "transit/keys/' + key.name + '/config" { capabilities=["update"] }').join('\n') });
      custodianToken = (await vaultRequest('auth/token/create', { policies: ['native-recommission-custodian'], no_default_policy: true, ttl: '1h' })).auth.client_token;
      const setup = new Client({ connectionString: roleURI }); await setup.connect();
      try { identity = await require('../../lib/tenant-lifecycle/operation-window-readiness').admit(setup, ns.lifecycle, {maintenance:true,intakeProfile:profile}); }
      finally { await setup.end(); }
      const entries = manifests.validate(['api', 'realtime', 'evaluator', 'tenant-admin'].map(name => ({ id: name, roles: [name],
        namespaces: admission.catalogues.filter(entry => entry.kind !== 'lifecycle').map(entry => entry.namespace),
        endpoint: { socketPath: path.join(socketDirectory, name + '.sock'), maxBytes: 1048576, timeoutMs: 5000 } })));
      participantEntries = entries;
      for (const entry of entries) {
        const client = new Client({ connectionString: peerURI }); await client.connect(); backends.push(client);
        const row = (await client.query('SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth,' + datastore.SQL + ' FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
        const incarnation = crypto.randomUUID();
        const status = request => ({ version: 4, ownership: entry.roles.includes('realtime') ? { ...entry.slice, rule: require('../../lib/pool-membership/slice').RULE } : null, participant: entry.id, incarnation, namespace: ns.lifecycle, roles: [...entry.roles], tenants: [A, B],
          namespaces: [...entry.namespaces], identity, intakeProfileDigest:profile.digest, datastore: datastore.identity(row), backends: [{ pid: row.pid, role: row.role, birth: row.birth }], request });
        peers.push(await transport.open(entry.endpoint, contracts.lifecycleParticipant, () => ({ getStatus: async (_ctx, body) => status(body.request),
          invalidateTenant: async (_ctx, body) => ({ ...status(body.request), tenant: body.tenant }),
          getApiHealth: async (ctx, body) => ({request:body.request,ready:true,storageReady:true}), getOperations: async (_ctx, body) => ({ request: body.request, tenant: body.tenant, participant: entry.id, incarnation, operations: [] }) })));
      }
      cohort = await cohorts.createRemote({ namespace: ns.lifecycle, tenants: [A, B], participants: entries, intakeProfile:profile });
      pool = new Pool({ connectionString: roleURI, max: 1 });
      controller = maintenance.create({ namespace: ns.lifecycle, locks, pool, cohort, drainTimeoutMs: 10000, ...selectionOptions() });
      life = admission.lifecycle.withCapabilities({
        authorize: async ({ connection, tenant }) => {
          const rows = (await connection.query('SELECT active FROM ' + table('lifecycle', 'tenant_lifecycle_restore_authority') + ' WHERE tenant_id=$1 AND role_oid=CURRENT_USER::regrole::oid', [tenant])).rows;
          return { tenant, allowed: rows.length === 1 && rows[0].active === true, current: true, plane: 'operator', principal: role, consumer: 'recommission' };
        },
        verifyDurableArtifact: lifecycle.createFilesystemArtifactVerifier({ directory: artifactDirectory }),
        removeArtifact: lifecycle.createFilesystemArtifactRemover({ directory: artifactDirectory }), keyInventory: async ({ tenant }) => keysOf(tenant),
        executionWindow: async ({ connection, tenant }) => {
          const rows = (await connection.query('SELECT phase,artifact_digest FROM ' + table('lifecycle', 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [tenant])).rows;
          return { tenant, current: rows.length === 1 && rows[0].phase === 'suspended', quiesced: rows.length === 1 && rows[0].phase === 'suspended' };
        }, recommissionRegistryNamespace: registryNamespace, currentConfiguration, recommissionProviderFor: async ({ tenant }) => provider(tenant),
        recommissionSignersFor: async ({ tenant }) => Object.fromEntries(['access', 'management', 'human-data', 'human-management'].map(purpose => [purpose,
          require('../../lib/secrets/vault-access-signing').createVaultAccessSigner({ address: vault.address, mount: 'transit', allowInsecureLoopback: true,
            signingKey: rules.vaultKey(tenant, purpose), signingVersion: 1, getToken: async () => runtimeToken })])),
        keyCustodian: require('../../lib/secrets/vault-transit-custodian').createVaultTransitCustodian({ address: vault.address, getToken: async () => custodianToken, allowInsecureLoopback: true,
          keyAllowed: async ({ tenant, mount, name }) => keysOf(tenant).some(key => key.mount === mount && key.name === name) })
      });
      // Build typed rows through the real source port under the real branded
      // controller, never by inventing a lease/cursor/window phase in SQL.
      for (const tenant of [A, B]) await controller.withRestore(tenant, { artifactDigest: 'a'.repeat(64) }, async ({ connection, maintenanceClaim }) => {
        await maintenance.assertHeld(maintenanceClaim, { connection, tenant, artifactDigest: 'a'.repeat(64) });
        const generation = (await connection.query('SELECT generation::text AS generation FROM ' + table('lifecycle', 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [tenant])).rows[0].generation;
        if(native){
          for(const entry of life.CATALOGUE.filter(value=>value.tables.includes('tenant_consumer_checkpoint')))await connection.query('DELETE FROM \"'+ns[entry.kind]+'\".tenant_consumer_checkpoint WHERE tenant_id=$1',[tenant]);
          const descriptor=require('../../lib/tenant-lifecycle/recommission-checkpoints').describe({nativeSelection:profile,replays:replays(),namespaces:ns,catalogues:life.CATALOGUE});
          await require('../../lib/tenant-lifecycle/recommission-checkpoints').provision(connection.query.bind(connection),descriptor,{tenant,generation,connection,maintenanceClaim,artifactDigest:'a'.repeat(64)});
        }else await require('../../lib/pgstream/pool-checkpoint-provision').provisionCheckpoint(connection.query.bind(connection), profile, { tenant, generation, enabled: false });
      });
    });

    after(async function () {
      try {
        if (controller) await controller.close(); if (cohort) await cohort.close();
        for (const peer of peers) await peer.close(); for (const backend of backends) await backend.end();
        if (pool) await pool.end();
      } finally {
        if (previousMode !== undefined) scope.setTenancyMode(previousMode);
        for (const container of containers.reverse()) {
          const actual = JSON.parse(docker(['inspect', container]))[0];
          assert.equal(actual.Config.Labels['org.nightscout.test.owner'], prefix); assert.equal(actual.Id, container);
          docker(['rm', '-f', '-v', container]);
        }
        for (const directory of [socketDirectory, artifactDirectory]) if (directory) fs.rmSync(directory, { recursive: true, force: true });
        roots.clear();
      }
    });

    if(native)it('admits the selected native ledger to restricted physical serving ports and blocks replacement until COMMIT',async function(){
      const lifetime=prefix+'_life',data=prefix+'_data',password=crypto.randomBytes(24).toString('hex');
      const nativeSelection=require('../../lib/tenant-lifecycle/native-selection'),windows=require('../../lib/tenant-lifecycle/operation-window');
      await admin(async client=>{
        for(const role of [lifetime,data]){
          await client.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '"+password+"'");
          await client.query('GRANT USAGE ON SCHEMA '+q(ns.lifecycle)+' TO '+q(role));
          for(const name of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])await client.query('GRANT SELECT ON '+table('lifecycle',name)+' TO '+q(role));
          for(const sql of nativeSelection.servingGrants({namespace:ns.lifecycle,role}))await client.query(sql);
        }
        await client.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON '+table('lifecycle','tenant_lifecycle_operations')+' TO '+q(lifetime));
        await client.query('GRANT EXECUTE ON FUNCTION '+q(ns.lifecycle)+'.tenant_lifecycle_backend_birth() TO '+q(lifetime));
      });
      const uri=role=>{const value=new URL(adminURI);value.username=role;value.password=password;return value.toString();};
      const lifetimePool=new Pool({connectionString:uri(lifetime),max:1});
      const window=windows.create({namespace:ns.lifecycle,locks,pool:lifetimePool,intakeProfile:profile});let lower;
      try{
        await window.ready();assert.deepEqual(windows.catalogue(window),nativeSelection.catalogue(profile));
        lower=await require('../../lib/storage/postgres-connection')({connectionString:uri(data),max:1,operationWindow:window});
        for(const tenant of [A,B])await window.run(tenant,()=>lower.withTenant(tenant,async()=>assert.deepEqual((await lower.query('SELECT tenant_id FROM '+table('lifecycle','tenant_lifecycle_windows'))).rows,[{tenant_id:tenant}])));
        let unlock,entered,physicalReady;const held=new Promise(resolve=>{physicalReady=resolve;}),gate=new Promise(resolve=>{unlock=resolve;});
        const transaction=assert.rejects(lower.withTenant(A,async()=>{await lower.query('SELECT 1');physicalReady();await gate;}),{code:'LIFECYCLE_WINDOW_SUSPENDED'});
        await held;
        const replacement=controller.withRestore(A,{artifactDigest:'b'.repeat(64)},async()=>{entered=true;});
        try{await sleep(150);assert.equal(entered,undefined,'checked native DATA transaction must block replacement');}finally{unlock();}
        await transaction;await replacement;assert.equal(entered,true);
        await admin(client=>client.query('REVOKE SELECT(generation) ON '+table('lifecycle','tenant_lifecycle_recommission')+' FROM '+q(lifetime)));
        const refusedPool=new Pool({connectionString:uri(lifetime),max:1}),refused=windows.create({namespace:ns.lifecycle,locks,pool:refusedPool,intakeProfile:profile});
        try{await assert.rejects(refused.ready(),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});}finally{await refused.close();await refusedPool.end();}
        await admin(async client=>{for(const sql of nativeSelection.servingGrants({namespace:ns.lifecycle,role:lifetime}))await client.query(sql);});
      }finally{if(lower)await lower.end();await window.close();await lifetimePool.end();}
    });

    if(native)it('restores seven clinical domains through the native source guard while preserving pending and accepted queue identities',async function(){
      const beforeB=await snapshot(B);
      const values=require('./tenant-deployment-notifications').notificationInputs({tenants:[A,B],now:BASE,outboxRole:prefix+'_one',checkpointWriterRole:prefix+'_two',ackReaderRole:prefix+'_three'}).rows;
      await admin(async client=>{
        for(const [name,rows]of Object.entries(values))for(const row of rows.filter(value=>value.consumer==='synthetic_realtime'&&value.tenant_id===A)){
          const keys=Object.keys(row);await client.query('INSERT INTO '+table('notification_outbox',name)+' ('+keys.map(q).join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',keys.map(key=>row[key]));
        }
      });
      const {logicalPool,logicalController}=await logicalControllerFor(A);
      const queues=()=>admin(async client=>{const result={};for(const name of ['tenant_notification_heads','tenant_notification_requests','tenant_notification_state'])result[name]=artifacts.digestRows((await client.query('SELECT * FROM '+table('notification_outbox',name)+' WHERE tenant_id=$1',[A])).rows);return result;});
      try{
        const artifact=await life.exportTenant(port,{tenant:A,namespaces:ns,sourceCommit}),before=await queues();
        const alarms=await admin(client=>client.query('SELECT * FROM '+table('alarm_suppression','tenant_alarm_suppression')+' WHERE tenant_id=$1',[A]));
        await admin(async client=>{await client.query('BEGIN');try{await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);await client.query('UPDATE '+table('entries','entries')+" SET doc=jsonb_set(doc,'{value}','555'::jsonb) WHERE tenant_id=$1",[A]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}});
        const result=await logicalController.withRestore(A,{artifactDigest:artifact.digest},({connection,maintenanceClaim})=>life.restoreLogical(connection,artifact,{tenant:A,namespaces:ns,ledgerNamespace:ns.lifecycle,maintenanceClaim}));
        assert.equal(result.result.tables,7);assert(result.result.replaced>0);
        assert.deepEqual(await queues(),before,'pending, uncertain and accepted request/producer rows retain their exact IDs and payloads');
        assert.deepEqual((await admin(client=>client.query('SELECT * FROM '+table('alarm_suppression','tenant_alarm_suppression')+' WHERE tenant_id=$1',[A]))).rows,alarms.rows);
        const restored=await admin(client=>client.query('SELECT doc FROM '+table('entries','entries')+' WHERE tenant_id=$1 ORDER BY "_id"',[A]));
        assert(restored.rows.every(row=>row.doc.value!==555));
        // Re-establish the original independent hole after logical restore's
        // fresh insertion sequence; recommission must retain this exact floor.
        await admin(async client=>{await client.query('BEGIN');try{
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
          for(const kind of ordered){const id='post-restore-hole-'+kind;
            await client.query('INSERT INTO '+table(kind,kind)+' (tenant_id,id_kind,doc) VALUES($1,\'string\',$2)',[A,JSON.stringify({_id:id,identifier:id,value:99})]);
            await client.query('DELETE FROM '+table(kind,kind)+' WHERE tenant_id=$1 AND "_id"=$2',[A,id]);
          }
          await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}});
        assert.deepEqual(await snapshot(B),beforeB);
      }finally{await logicalController.close();await logicalPool.end();}
    });

    it('reconstructs seven nonempty domains twice, preserving B, retained ciphertext and credential compatibility without old DATAJWT authority', async function () {
      const beforeB = await snapshot(B), first = await erase(BASE + 100);
      assert.deepEqual(await snapshot(B), beforeB);
      await refusedRestore(first, { code: 'LIFECYCLE_RETENTION_EXPIRED' }, { now: () => first.at + 30 * DAY });
      configMissing = true;
      try { await refusedRestore(first, { code: native?'LIFECYCLE_NATIVE_SOURCE_CHANGED':'LIFECYCLE_RECOMMISSION_REPLAY_REQUIRED' }); }
      finally { configMissing = false; }
      if(native)await refusedRestore(first,/NATIVE_BEFORE_DATA_INTERRUPT/,{onRow(){throw new Error('NATIVE_BEFORE_DATA_INTERRUPT');}});
      for (let cycle = 0, record = first; cycle < 2; cycle++) {
        const captured = record.artifact, oldKey = captured.tables['legacy.legacy_data_keys'].find(key => key.signing), config = captured.tables['legacy.legacy_credential_config'][0];
        const subject = captured.tables['legacy.legacy_credential_subjects'][0];
        const codec = require('../../lib/tenant-authorization/legacy-data-token').create({ issuer: 'native-recommission', audience: 'native-data', now: () => 1000 });
        const oldToken = codec.issue(A, { kind: 'subject', subjectId: subject.subject_id, rootVersion: config.root_version, credentialVersion: subject.credential_version },
          { kid: oldKey.kid, privateKey: oldKey.private_key }).token;
        let commits = 0;
        if(native&&!cycle){
          await assert.rejects(reconstruct(record,{onCommitted:()=>{commits++;throw new Error('NATIVE_AFTER_DATA_INTERRUPT');}}),/NATIVE_AFTER_DATA_INTERRUPT/);
          const held=await admin(client=>client.query('SELECT phase FROM '+table('lifecycle','tenant_lifecycle_key_retention')+' WHERE request_id=$1',[record.requestId]));assert.equal(held.rows[0].phase,'restored');
          const activity=await admin(client=>client.query('SELECT suspended FROM '+table('lifecycle','tenant_activity')+' WHERE tenant_id=$1',[A]));assert.equal(activity.rows[0].suspended,true);
          await resumeFailedClaim();
        }else{const result=await reconstruct(record,{onCommitted:()=>{commits++;}});assert.equal(result.result.oracle.differences,0);}
        assert.equal(commits,1);
        await admin(async client => {
          for (const kind of clinical) {
            const actual = (await client.query('SELECT id_kind,doc' + (ordered.includes(kind) ? ',insertion_ordinal::text' : '') + ' FROM ' + table(kind, kind) + ' WHERE tenant_id=$1' + (ordered.includes(kind) ? ' ORDER BY insertion_ordinal' : ' ORDER BY "_id"'), [A])).rows;
            const expected = captured.tables[kind + '.' + kind].slice().sort((a, b) => ordered.includes(kind) ? Number(a.insertion_ordinal) - Number(b.insertion_ordinal) : a.doc._id.localeCompare(b.doc._id));
            assert.equal(actual.length, expected.length); assert(actual.length > 0);
            for (let index = 0; index < actual.length; index++) {
              const desired = { ...expected[index].doc }, restored = { ...actual[index].doc };
              if (kind !== 'activity') { assert(restored.srvModified > Number(captured.tables['clock.tenant_write_clock'][0].last_stamp)); delete desired.srvModified; delete restored.srvModified; }
              assert.deepEqual(restored, desired); assert.equal(actual[index].id_kind, expected[index].id_kind);
            }
            if (ordered.includes(kind)) {
              const counter = (await client.query('SELECT last_ordinal::text AS floor FROM ' + table(kind, 'tenant_insertion_ordinal') + ' WHERE tenant_id=$1', [A])).rows[0].floor;
              assert.equal(counter, captured.tables[kind + '.tenant_insertion_ordinal'][0].last_ordinal);
              assert(BigInt(counter) > actual.reduce((maximum, row) => BigInt(row.insertion_ordinal) > maximum ? BigInt(row.insertion_ordinal) : maximum, 0n), 'captured floor beyond surviving MAX is retained');
            }
          }
          const secrets = (await client.query('SELECT id,ciphertext FROM ' + table('secrets', 'secret_records') + ' WHERE tenant_id=$1 ORDER BY id', [A])).rows;
          assert.equal(hash(secrets), hash(captured.tables['secrets.secret_records'].map(row => ({ id: row.id, ciphertext: row.ciphertext })).sort((a, b) => a.id.localeCompare(b.id))), 'ciphertext bytes are recovered exactly');
          const state = (await client.query('SELECT phase,generation::text FROM ' + table('lifecycle', 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [A])).rows[0]; assert.equal(state.phase, 'active');
          const links = (await client.query('SELECT activated FROM ' + table('lifecycle', 'tenant_lifecycle_recommission') + ' WHERE tenant_id=$1', [A])).rows;
          assert.equal(links.length, cycle + 1); assert(links.every(link => link.activated));
          if(native){
            const retained=(await client.query('SELECT phase FROM '+table('lifecycle','tenant_lifecycle_key_retention')+' WHERE tenant_id=$1',[A])).rows;assert.equal(retained.length,cycle+1);assert(retained.every(row=>row.phase==='restored'));
            assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND tablename=\'pgstream_intake_profile\'',[profile.binding.namespace])).rows[0].n,0,'native successor installs no pool intake profile');
            const work=(await client.query('SELECT work_version,work_observed,work_completed FROM '+'\"'+profile.binding.namespace+'\".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[A,profile.binding.consumer+'-completed'])).rows[0];assert.equal(work.work_version,2);assert.equal(work.work_observed[5],'1');assert.equal(work.work_completed[5],null);
          }
          for (const [kind, name] of [['access', 'access_sessions'], ['human_session', 'human_sessions'], ['human_session', 'human_access_tokens']]) {
            if (!cycle) assert(captured.tables[kind + '.' + name].length > 0, 'nonempty captured sessions make the reset oracle meaningful');
            assert.equal((await client.query('SELECT count(*)::int AS n FROM ' + table(kind, name) + ' WHERE tenant_id=$1', [A])).rows[0].n, 0, 'old auth session not replayed');
          }
          assert.equal((await client.query('SELECT generation FROM ' + table('access', 'access_credentials') + ' WHERE tenant_id=$1', [A])).rows[0].generation,
            captured.tables['access.access_credentials'][0].generation + 1);
          assert.equal((await client.query('SELECT count(*)::int AS n FROM ' + table('access', 'access_keys') + " WHERE tenant_id=$1 AND kid='historical_access' AND active", [A])).rows[0].n, 0,
            'retained historical registry key is not selected as a current capability');
          assert.equal((await client.query('SELECT version FROM ' + table('subject_policy', 'subject_policy') + ' WHERE tenant_id=$1', [A])).rows[0].version,
            captured.tables['subject_policy.subject_policy'][0].version + 1);
          assert.equal(artifacts.digestRows((await client.query('SELECT * FROM ' + table('alarm_suppression', 'tenant_alarm_suppression') + ' WHERE tenant_id=$1', [A])).rows),
            artifacts.digestRows(captured.tables['alarm_suppression.tenant_alarm_suppression']), 'absolute ACK expiry was not extended');
          if(!native){
          const authority = await scope.withTenant(A, async () => {
            await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
            try { return await require('../../lib/tenant-lifecycle/pool-authority').create({ namespace: ns.lifecycle }).read(client.query.bind(client), A); }
            finally { await client.query('ROLLBACK'); }
          });
          assert.equal(authority.eligibility, 'active', 'historical activated deletion does not block the current lifetime');
          }else{const activity=(await client.query('SELECT suspended,deletion_request_id FROM '+table('lifecycle','tenant_activity')+' WHERE tenant_id=$1',[A])).rows[0];assert.equal(activity.suspended,false);assert.equal(activity.deletion_request_id,null);}
        });
        const reader = async () => admin(async client => {
          const configRow = (await client.query('SELECT root_verifiers,root_version FROM ' + table('legacy', 'legacy_credential_config') + ' WHERE tenant_id=$1', [A])).rows[0];
          const subjects = (await client.query('SELECT subject_id,credential_version,verifiers FROM ' + table('legacy', 'legacy_credential_subjects') + ' WHERE tenant_id=$1', [A])).rows;
          const keys = (await client.query('SELECT kid,public_key,private_key,active,signing FROM ' + table('legacy', 'legacy_data_keys') + ' WHERE tenant_id=$1', [A])).rows;
          return { rootVerifiers: configRow.root_verifiers, rootVersion: configRow.root_version,
            subjects: subjects.map(row => ({ subjectId: row.subject_id, credentialVersion: row.credential_version, verifiers: row.verifiers })),
            keys: keys.map(row => ({ kid: row.kid, publicKey: row.public_key, privateKey: row.private_key, active: row.active, signing: row.signing })) };
        });
        const verifier = require('../../lib/secrets/legacy-verifiers').create({ read: reader, verifyToken: codec.verify });
        assert.equal(await verifier.verifyLegacyCredential({ tenant: A }, { token: oldToken }, async () => true), null);
        const sha1 = crypto.createHash('sha1').update(roots.get(A)).digest('hex');
        assert.equal((await verifier.verifyLegacyCredential({ tenant: A }, { apiSecret: sha1 })).kind, 'root');
        const digest = crypto.createHash('sha1').update(sha1 + subject.subject_id).digest('hex');
        const principal = await verifier.verifyLegacyCredential({ tenant: A }, { apiSecret: digest });
        const fresh = (await reader()).keys.find(key => key.active && key.signing); assert(fresh && fresh.kid !== oldKey.kid);
        assert.equal((await verifier.verifyLegacyCredential({ tenant: A }, { token: codec.issue(A, principal, fresh).token }, async () => true)).subjectId, subject.subject_id);
        const ownerConnection = new Client({ connectionString: ownerURI }); await ownerConnection.connect();
        try {
          await ownerConnection.query('BEGIN'); await ownerConnection.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
          const ownerPolicy = require('../../lib/subject-admin/owner-policy').createOwnerPolicy({ namespace: ns.authorization, catalogue: ['*'] });
          await ownerPolicy.authorizePermissions(ownerConnection, { tenant: A, principal: 'subject_a', consumer: 'native_owner' }, ['api:entries:read']);
          await assert.rejects(ownerPolicy.authorizePermissions(ownerConnection, { tenant: A, principal: 'archived_owner', consumer: 'native_owner' }, ['api:entries:read']), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
        } finally { await ownerConnection.query('ROLLBACK'); await ownerConnection.end(); }
        assert.deepEqual(await snapshot(B), beforeB);
        if (!cycle) {
          const second = await erase(BASE + 2000);
          await refusedRestore({ ...second, artifact: first.artifact }, { code: 'LIFECYCLE_RECOMMISSION_EXACT_ARTIFACT_REQUIRED' });
          record = second;
        }
      }
    });

    it('refuses a missing branded claim before reconstruction and preserves both tenants', async function () {
      const beforeA = await snapshot(A), beforeB = await snapshot(B);
      const artifact = await life.exportTenant(port, { tenant: A, namespaces: ns, sourceCommit });
      await assert.rejects(life.recommission(port, artifact, { tenant: A, namespaces: ns, ledgerNamespace: ns.lifecycle,
        requestId: crypto.randomUUID(), maintenanceClaim: Object.freeze({ forged: true }) }), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
      assert.deepEqual(await snapshot(A), beforeA); assert.deepEqual(await snapshot(B), beforeB);
    });

    it('refuses a different current selected profile before draining or changing tenant rows', async function () {
      const beforeA = await snapshot(A), beforeB = await snapshot(B);
      if(native){
        const connection={query:(sql,values)=>admin(client=>client.query(sql,values))};
        const configuration=await currentConfiguration({tenant:A,connection});
        const selected=require('../../lib/tenant-lifecycle/native-selection');
        assert.throws(()=>selected.validate({...profile}),{code:'LIFECYCLE_NATIVE_SELECTION_REQUIRED'});
        const foreign=selected.create({...profile.binding,source:{...profile.binding.source,system_id:profile.binding.source.system_id+'1'}});
        await assert.rejects(selected.assertCurrent(connection,foreign,{nativeSource:{source:foreign.binding.source,generation:foreign.binding.generation}}),{code:'LIFECYCLE_NATIVE_SOURCE_CHANGED'});
        configuration.nativeSource.generation='foreign-generation';
        await assert.rejects(require('../../lib/tenant-lifecycle/native-selection').assertCurrent(connection,profile,configuration),{code:'LIFECYCLE_NATIVE_SOURCE_CHANGED'});
        assert.deepEqual(await snapshot(A),beforeA);assert.deepEqual(await snapshot(B),beforeB);return;
      }
      const fields = ['namespace', 'membershipNamespace', 'lifecycleNamespace', 'role', 'operatorRole', 'consumer', 'codec', 'generationDomain', 'sliceRule'];
      const changed = require('../../lib/pgstream/pool-intake-profile').create({ ...Object.fromEntries(fields.map(key => [key, profile.binding[key]])), consumer: 'evaluator-different-current-profile' });
      await assert.rejects(cohorts.createRemote({ namespace: ns.lifecycle, tenants: [A, B], participants: participantEntries, intakeProfile: changed }), { code: 'RESTORE_COHORT_INTAKE_PROFILE_MISMATCH' });
      assert.deepEqual(await snapshot(A), beforeA); assert.deepEqual(await snapshot(B), beforeB);
    });

    it('refuses recovery after actual retained-key destruction and preserves B keys and rows', async function () {
      const beforeB = await snapshot(B), record = await erase(BASE + 3000);
      await life.destroyRetainedKeys(port, { tenant: A, namespaces: ns, ledgerNamespace: ns.lifecycle, requestId: record.requestId,
        now: () => record.at + 30 * DAY, intent: require('../../lib/tenant-lifecycle/key-retention').destroyIntent(A, record.requestId) });
      await refusedRestore(record, { code: 'LIFECYCLE_KEYS_DESTROYED' }, { now: () => record.at + 30 * DAY + 1 });
      assert.deepEqual(await snapshot(B), beforeB);
      const bytes = await provider(B).decrypt((await admin(client => client.query('SELECT ciphertext FROM ' + table('secrets', 'secret_records') + ' WHERE tenant_id=$1', [B]))).rows[0].ciphertext);
      try { assert(Buffer.isBuffer(bytes) && bytes.length > 0); } finally { bytes.fill(0); }
    });
    if(native)it('keeps an executed deletion suspended after ordinary logical-only restore and data-replaced resume',async function(){
      const beforeA=await snapshot(A),at=BASE+4000;
      const artifact=await life.exportTenant(port,{tenant:B,namespaces:ns,sourceCommit,now:()=>at-10});
      await lifecycle.saveTenantArtifact(artifact,{directory:artifactDirectory});
      const options={tenant:B,namespaces:ns,ledgerNamespace:ns.lifecycle,artifact,now:()=>at};
      const request=await life.requestDeletion(port,options);
      await life.confirmDeletion(port,{...options,requestId:request.requestId});
      await life.executeDeletionWithMaintenance(port,{...options,requestId:request.requestId,controller});
      const {logicalPool,logicalController}=await logicalControllerFor(B);
      try{
        const restore=()=>logicalController.withRestore(B,{artifactDigest:artifact.digest},({connection,maintenanceClaim})=>life.restoreLogical(connection,artifact,{tenant:B,namespaces:ns,ledgerNamespace:ns.lifecycle,maintenanceClaim}));
        await assert.rejects(restore(),{code:'LIFECYCLE_LOGICAL_LIVE_FLOOR_REQUIRED'});
        const recover=async expected=>{
          const recovery=require('../../lib/tenant-lifecycle/restore-resume').create({namespace:ns.lifecycle,locks,pool:logicalPool,cohort,nativeSelection:profile});
          try{const inspection=await recovery.inspect(B);assert.equal(inspection.interrupted,expected);await recovery.resume(B,{claimId:inspection.claimId});}finally{await recovery.close();}
        };
        await recover('before-data');
        // Adversarial fixture setup: a trusted DBA supplies a fresh current
        // clock only. This is not a supported deleted-tenant bootstrap. It
        // makes logical-only DATA reachable without writing a recommission link.
        await admin(client=>client.query('INSERT INTO '+table('clock','tenant_write_clock')+' (tenant_id,last_stamp,last_delete_stamp) VALUES($1,$2,$2)',[B,String(BASE+5000)]));
        await assert.rejects(logicalController.withRestore(B,{artifactDigest:artifact.digest},async ({connection,maintenanceClaim})=>{
          await life.restoreLogical(connection,artifact,{tenant:B,namespaces:ns,ledgerNamespace:ns.lifecycle,maintenanceClaim});
          maintenance.registerAfterCommit(maintenanceClaim,{connection,tenant:B,artifactDigest:artifact.digest},()=>{throw new Error('NATIVE_LOGICAL_AFTER_DATA_INTERRUPT');});
        }),/NATIVE_LOGICAL_AFTER_DATA_INTERRUPT/);
        await recover('data-replaced');
        await admin(async client=>{
          const activity=(await client.query('SELECT suspended,deletion_request_id FROM '+table('lifecycle','tenant_activity')+' WHERE tenant_id=$1',[B])).rows[0];
          assert.equal(activity.suspended,true,'NATIVE_LOGICAL_RESTORE_MUST_NOT_RECOMMISSION');assert.equal(activity.deletion_request_id,request.requestId);
          assert.equal((await client.query('SELECT count(*)::int AS n FROM '+table('lifecycle','tenant_lifecycle_recommission')+' WHERE tenant_id=$1',[B])).rows[0].n,0);
          for(const kind of clinical)assert((await client.query('SELECT count(*)::int AS n FROM '+table(kind,kind)+' WHERE tenant_id=$1',[B])).rows[0].n>0);
        });
        await logicalController.withRestore(B,{artifactDigest:artifact.digest},({connection,maintenanceClaim})=>life.restoreLogical(connection,artifact,{tenant:B,namespaces:ns,ledgerNamespace:ns.lifecycle,maintenanceClaim}));
        const stillClosed=await admin(client=>client.query('SELECT suspended,deletion_request_id FROM '+table('lifecycle','tenant_activity')+' WHERE tenant_id=$1',[B]));
        assert.equal(stillClosed.rows[0].suspended,true,'NATIVE_LOGICAL_RESTORE_MUST_NOT_RECOMMISSION');assert.equal(stillClosed.rows[0].deletion_request_id,request.requestId);
        assert.deepEqual(await snapshot(A),beforeA);
      }finally{await logicalController.close();await logicalPool.end();}
    });
  });

};
