'use strict';

// Owned native API and realtime CLI processes. Clinical domains, registry/Vault
// and current legacy authority are real. No existing deployment is selected.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { run } = require('../../lib/migrations/postgres');
const scope = require('../../lib/storage/tenant-scope');
const ownership = require('../../lib/realtime-ownership');
const slice = require('../../lib/pool-membership/slice');
const prestart = require('./platform-prestart');
const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
const projectionDomains = require('../../lib/data/tenant-projection-evaluator').domains;
const order = require('../../lib/server/tenant-socket-order-port').catalogues;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha1').update(value).digest('hex');
const quote = value => '"' + value + '"';
const freePort = () => new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
async function until (fn, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(25); } throw new Error('SHARD_NATIVE_WAIT: ' + label); }
module.exports = function fixture () {
  let lab, provisioner, directory, edge, previousMode, config, map, slicePeers, routeReader;
  const roles = [], schemas = [], children = new Set(), workers = new Map(), roots = new Map(), credentials = new Map(), hosts = new Map(), edgeSockets = new Set();
  let api, activity, display, check, alarm, publisher, lastScreen, activityWriter, operationState, apiService, evaluator, producer, evaluatorConfig, realtimeConfig, proof, floorVerifier;
  const tenants = [];
  while (tenants.length < 2) { const id = randomUUID(); if (slice.bucket(id, 2) === tenants.length) tenants.push(id); }
  const q = (sql, values) => lab.admin.query(sql, values);
  async function role (suffix) {
    const name = 'sr_' + suffix + '_' + lab.id, password = randomBytes(24).toString('hex');
    await q('CREATE ROLE ' + quote(name) + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'"); roles.push(name);
    const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = name; url.password = password; return { name, url: url.toString() };
  }
  async function readerGrants (selected, namespaces) { for (const ns of namespaces) { await q('GRANT USAGE ON SCHEMA ' + quote(ns) + ' TO ' + quote(selected.name)); await q('GRANT SELECT ON ALL TABLES IN SCHEMA ' + quote(ns) + ' TO ' + quote(selected.name)); } }
  function start (name, roleName, env) {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../bin/nightscout.js'), 'multitenant', roleName], { cwd: directory, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const worker = { name, child, stdout: '', stderr: '', exit: null };
    child.stdout.on('data', bytes => { worker.stdout += bytes; }); child.stderr.on('data', bytes => { worker.stderr += bytes; });
    worker.exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { worker.exit = { code, signal }; resolve(worker.exit); }); });
    children.add(worker); return worker;
  }
  async function ready (worker, name) {
    await until(() => { assert.equal(worker.exit, null, 'actual ' + name + ' child refused: ' + worker.stderr); return new RegExp('Listening for role ' + name + ' on 127\\.0\\.0\\.1:(\\d+)').exec(worker.stdout); }, name + ' listener');
    worker.port = Number(new RegExp('Listening for role ' + name + ' on 127\\.0\\.0\\.1:(\\d+)').exec(worker.stdout)[1]); return worker;
  }
  async function stop (worker) {
    if (!worker.exit) { worker.child.kill('SIGTERM'); const deadline = setTimeout(() => { if (!worker.exit) worker.child.kill('SIGKILL'); }, 10000); try { await worker.exited; } finally { clearTimeout(deadline); } }
    assert.throws(() => process.kill(worker.child.pid, 0), error => error.code === 'ESRCH', 'independent kernel proof of old owner termination'); children.delete(worker);
  }
  function request (tenant, method, resource, body, port = api.port) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ hostname: '127.0.0.1', port, path: resource, method, agent: false, timeout: 5000,
        headers: { host: hosts.get(tenant), 'api-secret': hash(roots.get(tenant)), accept: 'application/json', ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text && (res.headers['content-type'] || '').includes('json') ? JSON.parse(text) : text }); });
      }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Native API request timeout'))); req.end(bytes);
    });
  }
  // The deployment's pre-start step before each serving role starts (decision
  // platform-application-boundary). The proof writer stays in this parent; a
  // refusal publishes no proof and the role then refuses at its start check.
  async function preStart (roleName, configFile, env) {
    try {
      await prestart.verify({ namespace: proof.namespace, writerURI: proof.writerURI, source: { PATH: process.env.PATH, ...env },
        targets: [{ role: roleName, configFile, ...(env.MULTITENANT_OPERATION_CONFIG ? { operationConfigFile: env.MULTITENANT_OPERATION_CONFIG } : {}) }] });
    } catch (error) { console.log('SHARD_PRE_START_REFUSED ' + JSON.stringify({ role: roleName, code: error.code || null, diagnostic: error.verificationDiagnostic || null })); }
  }
  async function startRealtime (id) {
    const row = map.workers.find(worker => worker.id === id);
    const env = { MULTITENANT_REALTIME_CONFIG: path.join(directory, 'realtime.json'), NS_SLICE_ORDINAL: String(row.ordinal), NS_SLICE_COUNT: '2', RT_PG: lab.urls.realtime, DISPLAY_PG: display.url, ACTIVITY_PG: activity.url,
      NS_SHARD_WARM_CONTROL_DIR: directory, NODE_OPTIONS:'--require '+path.join(__dirname,'realtime-sharding-diagnostics.cjs')+' --require '+path.join(__dirname,'realtime-sharding-controls.cjs'),
      NS_API_INTERNAL_SOCKET: path.join(directory, 'api.sock'), NS_SERVE_INTERNAL_SOCKET: row.address.socket, REALTIME_HOSTNAME: '127.0.0.1', REALTIME_PORT: String(new URL(row.consumerOrigin).port), NS_TENANT_READINESS: 'all' };
    if(operationState){
      const file=path.join(directory,'operation-rt-'+id+'.json');
      fs.writeFileSync(file,JSON.stringify(operationState.base));
      Object.assign(env,{MULTITENANT_OPERATION_CONFIG:file,LIFETIME_PG:operationState.lifetime.url,NS_POOL_OPERATION_MAX:'2',NS_API_INTERNAL_SOCKET:path.join(directory,'api-service.sock')});
    }
    require('../../lib/server/realtime/config').load(env);
    await preStart('realtime', env.MULTITENANT_REALTIME_CONFIG, env);
    // The realtime scope screen is the admin pre-start target check (decision
    // platform-application-boundary): it loads this exact role configuration
    // and runs the screens without publishing or revoking a proof.
    lastScreen = async () => {
      const admin = require('../../lib/server/serve/platform-verification-admin');
      await admin.checkTarget(admin.loadTarget({ role: 'realtime', configFile: env.MULTITENANT_REALTIME_CONFIG,
        ...(env.MULTITENANT_OPERATION_CONFIG ? { operationConfigFile: env.MULTITENANT_OPERATION_CONFIG } : {}) }, { PATH: process.env.PATH, ...env }));
    };
    const worker = await ready(start(id, 'realtime', env), 'realtime'); workers.set(id, worker); return worker;
  }
  async function setup ({ operation = false, apiOnly = false, paused = false } = {}) {
    if (!apiOnly) operation = 'sharded';
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi'); lab = await require('./tenant-registry-lab').createLab();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-realtime-sharding-'));
    const ns = Object.fromEntries(domains.map(domain => [domain, 'sr_' + domain + '_' + lab.id]));
    ns.clock = lab.namespaces.clock; ns.checkpoint = lab.namespaces.checkpoint;
    ns.evaluatorCheckpoint = 'sr_eval_checkpoint_' + lab.id;
    await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: ns.evaluatorCheckpoint, catalogue: require('../../migrations/candidates/postgres-evaluator-work-v2.json') }); schemas.push(ns.evaluatorCheckpoint);
    await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: ns.checkpoint, catalogue: require('../../migrations/candidates/postgres-realtime-output-v2.json') });
    for (const domain of domains) {
      const catalogue = order[domain] || require('../../lib/server/serve/postgres-domains').get(domain).catalogue;
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: ns[domain], catalogue }); schemas.push(ns[domain]);
      await q('GRANT USAGE ON SCHEMA ' + quote(ns[domain]) + ' TO ' + quote(lab.roles.api));
      await require('./tenant-insertion-grants').grant(lab.admin, { namespace: ns[domain], domain, role: lab.roles.api, catalogue });

    }
    for (const name of [ns.clock, ns.checkpoint]) { await q('GRANT USAGE ON SCHEMA ' + quote(name) + ' TO ' + quote(lab.roles.realtime)); await q('GRANT SELECT ON ' + quote(name) + '.schema_migrations TO ' + quote(lab.roles.realtime)); }
    await q('GRANT SELECT ON ' + quote(ns.clock) + '.tenant_write_clock TO ' + quote(lab.roles.realtime));
    await q('GRANT SELECT ON ' + quote(ns.checkpoint) + '.tenant_consumer_checkpoint TO ' + quote(lab.roles.realtime));
    for (const name of [ns.clock, lab.namespaces.authorization, lab.namespaces.secrets, lab.namespaces.legacy]) await q('GRANT USAGE ON SCHEMA ' + quote(name) + ' TO ' + quote(lab.roles.api));
    await q('GRANT SELECT,UPDATE(last_stamp,last_delete_stamp) ON ' + quote(ns.clock) + '.tenant_write_clock TO ' + quote(lab.roles.api));
    await q('GRANT SELECT ON ALL TABLES IN SCHEMA ' + quote(lab.namespaces.authorization) + ',' + quote(lab.namespaces.legacy) + ' TO ' + quote(lab.roles.api));
    await q('GRANT SELECT,INSERT ON ' + quote(lab.namespaces.secrets) + '.secret_records TO ' + quote(lab.roles.api));
    await q('GRANT INSERT ON ' + quote(lab.namespaces.secrets) + '.secret_audit TO ' + quote(lab.roles.api));
    evaluator = await role('evaluator');
    check = await role('check'); display = await role('display'); activity = await role('activity'); alarm = await role('alarm'); publisher = await role('publisher');
    proof = await prestart.install(lab.admin, { namespace: 'sr_proof_' + lab.id, adminURI: process.env.NS_TEST_POSTGRES_ADMIN_URI,
      registry: lab.namespaces.registry, floorReaders: [lab.roles.api], readers: [lab.roles.api, check.name, evaluator.name, lab.roles.realtime] }); schemas.push(proof.namespace); roles.push(proof.writer);
    const apiNamespaces = { ...Object.fromEntries(domains.map(domain => [domain, ns[domain]])), clock: ns.clock, authorization: lab.namespaces.authorization, legacy: lab.namespaces.legacy, secrets: lab.namespaces.secrets };
    for (const name of Object.values(apiNamespaces)) { await q('GRANT USAGE ON SCHEMA ' + quote(name) + ' TO ' + quote(check.name)); await q('GRANT SELECT ON ' + quote(name) + '.schema_migrations TO ' + quote(check.name)); }
    await readerGrants(display, [lab.namespaces.settings, lab.namespaces.operatorPolicy]);
    for (const reader of [activity.name, lab.roles?.api].filter(Boolean)) for (const sql of require('../../lib/tenant-activity/postgres').grants({ namespace: lab.namespaces.control, reader })) await q(sql);
    const activityOperator = await role('activity_operator');
    for (const sql of require('../../lib/tenant-activity/postgres').grants({ namespace: lab.namespaces.control, operator: activityOperator.name })) await q(sql);
    activityWriter = await require('../../lib/tenant-activity/postgres').create({ connectionString: activityOperator.url, namespace: lab.namespaces.control, capability: 'operator' });
    for (const selected of [publisher]) { await q('GRANT USAGE ON SCHEMA ' + quote(lab.namespaces.control) + ' TO ' + quote(selected.name)); await q('GRANT SELECT ON ' + ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'].map(table => quote(lab.namespaces.control) + '.' + table).join(',') + ' TO ' + quote(selected.name)); }
    for (const sql of require('../../lib/tenant-registry/postgres').grants({ namespace: lab.namespaces.registry, enumerators: [publisher.name] })) await q(sql);
    const alarmNamespace = 'sr_alarm_' + lab.id; schemas.push(alarmNamespace);
    await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: alarmNamespace, catalogue: require('../../migrations/candidates/postgres-alarm-suppression-v1.json') });
    for (const selected of [check, alarm]) { await q('GRANT USAGE ON SCHEMA ' + quote(alarmNamespace) + ' TO ' + quote(selected.name)); await q('GRANT SELECT ON ALL TABLES IN SCHEMA ' + quote(alarmNamespace) + ' TO ' + quote(selected.name)); }
    await q('GRANT INSERT,UPDATE(acked_at,expires_at) ON ' + quote(alarmNamespace) + '.tenant_alarm_suppression TO ' + quote(alarm.name));
    await readerGrants(alarm, [lab.namespaces.authorization]);
    const stream = require('./pgstream-native');
    const trustedWorker = {clock:ns.clock,activity:lab.namespaces.control,settings:lab.namespaces.settings,operatorPolicy:lab.namespaces.operatorPolicy};
    const presentation = { connectionEnv: 'DISPLAY_PG', namespaces: { settings: lab.namespaces.settings, operatorPolicy: lab.namespaces.operatorPolicy } };
    evaluatorConfig = {version:1,postgres:{connectionEnv:'EVAL_PG',namespaces:{...Object.fromEntries(projectionDomains.map(domain=>[domain,ns[domain]])),clock:ns.clock,checkpoint:ns.evaluatorCheckpoint}},
      consumer:'evaluator-sharding-native',pageSize:10,maxRows:10000,maxBytes:4194304,maxTenants:100,timeIntervalMs:60000,
      socketOrderDomains:Object.keys(order),registry:{namespace:lab.namespaces.registry,maxTenants:100,refreshMs:250},tenantSettings:presentation,trustedWorker,
      activity:{connectionEnv:'ACTIVITY_PG',namespace:lab.namespaces.control},pgstream:stream.configuration({prefix:'sr_'+lab.id,capability:stream.capability(process.env)}),
      platformVerification:{namespace:proof.namespace,role:'evaluator'}};
    realtimeConfig = {version:1,postgres:{connectionEnv:'RT_PG',namespaces:{clock:ns.clock,checkpoint:ns.checkpoint}},consumer:'realtime-sharding-native',maxRows:10000,maxBytes:1048576,maxTenants:100,
      registry:evaluatorConfig.registry,tenantSettings:presentation,trustedWorker,activity:{namespace:lab.namespaces.control},completedOutput:{namespace:ns.evaluatorCheckpoint,consumer:evaluatorConfig.consumer},
      maxMessageBytes:1048576,operationTimeoutMs:5000,authorizationRecheckMs:100,unauthorizedDeadlineMs:1000,platformVerification:{namespace:proof.namespace,role:'realtime'}};
    for(const namespace of [...projectionDomains.map(domain=>ns[domain]),ns.clock,ns.evaluatorCheckpoint]){
      await q('GRANT USAGE ON SCHEMA '+quote(namespace)+' TO '+quote(evaluator.name));
      await q('GRANT SELECT ON '+quote(namespace)+'.schema_migrations TO '+quote(evaluator.name));
    }
    for(const domain of projectionDomains)await require('./tenant-insertion-grants').grant(lab.admin,{namespace:ns[domain],domain,role:evaluator.name,catalogue:order[domain]||require('../../lib/server/serve/postgres-domains').get(domain).catalogue,mode:'reader'});
    await q('GRANT SELECT ON '+quote(ns.clock)+'.tenant_write_clock TO '+quote(evaluator.name));
    await q('GRANT SELECT,UPDATE(checkpoint,projection,contract_digest) ON '+quote(ns.evaluatorCheckpoint)+'.tenant_consumer_checkpoint TO '+quote(evaluator.name));
    for(const sql of require('../../lib/trusted-worker/postgres').grants({namespaces:trustedWorker,roles:[evaluator.name,lab.roles.realtime]}))await q(sql);
    for(const sql of require('../../lib/tenant-registry/postgres').grants({namespace:lab.namespaces.registry,enumerators:[evaluator.name]}))await q(sql);
    const replay = require('../../lib/storage/postgres-durable-replay')({ connection: { query () {}, withTenant () {}, transaction () {}, snapshotTransaction () {} },
      domains: Object.fromEntries(projectionDomains.map(domain => [domain, ns[domain] + '.' + domain])), clockTable: ns.clock + '.tenant_write_clock', checkpointTable: ns.evaluatorCheckpoint + '.tenant_consumer_checkpoint',
      consumer: evaluatorConfig.consumer, projectionVersion: 'clinical-current-rows-v1', pageSize: 10, maxRows: 10000 });
    const outputDigest=createHash('sha256').update(JSON.stringify(['evaluator-work-v2',ns.evaluatorCheckpoint,evaluatorConfig.consumer])).digest('hex');
    const checkpoints = [{namespace:ns.checkpoint,consumer:realtimeConfig.consumer,digest:require('../../lib/pgstream/realtime-receipt').contractDigest(ns.checkpoint,realtimeConfig.consumer)},
      {namespace:ns.evaluatorCheckpoint,consumer:evaluatorConfig.consumer,digest:replay.digest},{namespace:ns.evaluatorCheckpoint,consumer:evaluatorConfig.consumer+'-completed',digest:outputDigest}];
    for (const sql of require('../../lib/tenant-registry/provision').provisionerGrants({ namespaces: lab.namespaces, role: lab.roles.provisioner, checkpoints })) await q(sql);
    provisioner = require('../../lib/tenant-registry/provision').createProvisioning(lab.provisioningOptions({ checkpoints }));
    for (const [index, tenant] of tenants.entries()) await provisionTenant(tenant, 'shard-' + index + '.example.test');
    await lab.vaultRequest('sys/policies/acl/' + lab.mount + '_shard_api', { policy: ['decrypt','hmac','verify'].map(action => `path "${lab.mount}/${action}/tenant-*" { capabilities = ["update"] }`).join('\n') });
    const token = (await lab.vaultRequest('auth/token/create', { policies: [lab.mount + '_shard_api'], no_default_policy: true, ttl: '1h' })).auth.client_token;
    config = { version: 1, domains, legacy: true, context: true, writeClock: true, postgres: { connectionEnv: 'API_PG', readinessConnectionEnv: 'CHECK_PG', namespaces: apiNamespaces },
      vault: { address: lab.vault.address, mount: lab.mount, tokenEnv: 'VAULT_TOKEN', allowInsecureLoopback: true }, resolution: { mode: 'direct-alias' },
      registry: { namespace: lab.namespaces.registry, maxTenants: 100, refreshMs: 250 }, tenantSettings: presentation,
      activity: { namespace: lab.namespaces.control },
      socketForwarding: { maxTenants: 100, maxMessageBytes: 1048576, operationTimeoutMs: 5000, alarm: { connectionEnv: 'ALARM_PG', namespace: alarmNamespace } },
      platformVerification: { namespace: proof.namespace, role: 'api' } };
    fs.writeFileSync(path.join(directory, 'api.json'), JSON.stringify(config), { mode: 0o600 });
    if(operation==='sharded'){
      map={count:2,workers:[]};
      for(const [ordinal,id] of ['a','b'].entries())map.workers.push({id,ordinal,address:{socket:path.join(directory,id+'.sock')},consumerOrigin:'http://127.0.0.1:'+await freePort()});
    }
    const operationEnvironment = {};
    if (operation) {
      // The issuer's reviewed preparation revokes PUBLIC execution even when
      // this fixture does not select the optional management issuer role.
      await q('REVOKE ALL ON FUNCTION ' + quote(lab.namespaces.access) + '.management_session_authority(uuid,text,text) FROM PUBLIC');
      await q('REVOKE ALL ON FUNCTION ' + quote(lab.namespaces.settings) + '.tenant_settings_values_valid(jsonb) FROM PUBLIC');
      await q('GRANT EXECUTE ON FUNCTION ' + quote(lab.namespaces.settings) + '.tenant_settings_values_valid(jsonb) TO ' + quote(lab.roles.provisioner));
      const lifetime = await role('lifetime');
      for (const selected of [{ name: lab.roles.api },...(operation==='sharded'?[{name:lab.roles.realtime},evaluator]:[]), check, display, activity, alarm, lifetime]) {
        await q('GRANT USAGE ON SCHEMA ' + quote(lab.namespaces.control) + ' TO ' + quote(selected.name));
        await q('GRANT SELECT ON ' + ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'].map(table => quote(lab.namespaces.control) + '.' + table).join(',') + ' TO ' + quote(selected.name));
      }
      await q('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON ' + quote(lab.namespaces.control) + '.tenant_lifecycle_operations TO ' + quote(lifetime.name));
      await q('GRANT EXECUTE ON FUNCTION ' + quote(lab.namespaces.control) + '.tenant_lifecycle_backend_birth() TO ' + quote(lifetime.name));
      const foreignFunctions = (await q("SELECT p.oid::regprocedure::text AS function FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND NOT(n.nspname=$1 AND p.proname='tenant_lifecycle_backend_birth') AND has_function_privilege($2,p.oid,'EXECUTE')", [lab.namespaces.control,lifetime.name])).rows;
      assert.deepEqual(foreignFunctions, [], 'SHARD_NATIVE_LIFETIME_FOREIGN_FUNCTIONS '+JSON.stringify(foreignFunctions));
      const base={version:1,namespace:lab.namespaces.control,connectionEnv:'LIFETIME_PG',registry:{namespace:lab.namespaces.registry}};
      if(operation==='sharded')operationState={lifetime,base};
      const file = path.join(directory,'operation-api.json');
      fs.writeFileSync(file,JSON.stringify(base));
      Object.assign(operationEnvironment,{MULTITENANT_OPERATION_CONFIG:file,LIFETIME_PG:lifetime.url,NS_POOL_OPERATION_MAX:'2',NODE_OPTIONS:'--require '+path.join(__dirname,'realtime-sharding-diagnostics.cjs')});
    }
    const apiEnvironment = { ...operationEnvironment, MULTITENANT_PREVIEW_CONFIG: path.join(directory, 'api.json'), API_PG: lab.urls.api, CHECK_PG: check.url,
      DISPLAY_PG: display.url, ACTIVITY_PG: activity.url, ALARM_PG: alarm.url, VAULT_TOKEN: token,
      NS_SERVE_INTERNAL_SOCKET: path.join(directory, 'api.sock'), API_HOSTNAME: '127.0.0.1', API_PORT: '0', NS_TENANT_READINESS: 'all' };
    floorVerifier = require('../../lib/server/serve/platform-verification-admin').create({
      namespace: proof.namespace, connectionString: proof.writerURI, targets: [{ role: 'api', configFile: apiEnvironment.MULTITENANT_PREVIEW_CONFIG,
        ...(apiEnvironment.MULTITENANT_OPERATION_CONFIG ? { operationConfigFile: apiEnvironment.MULTITENANT_OPERATION_CONFIG } : {}) }]
    }, { PATH: process.env.PATH, ...apiEnvironment });
    await floorVerifier.verify();
    await floorVerifier.backfillTenantFloorsV1();
    await provisioner.close();
    provisioner = require('../../lib/tenant-registry/provision').createProvisioning({
      ...lab.provisioningOptions({ checkpoints }), postcondition: tenant => floorVerifier.verifyTenant(tenant)
    });
    api = await ready(start('api', 'api', apiEnvironment), 'api');
    async function seedEntries () {
      for (const [index, tenant] of tenants.entries()) assert.equal((await request(tenant, 'POST', '/api/v3/entries', { identifier: 'shard-initial-' + index, type: 'sgv', date: Date.now(), utcOffset: 0, app: 'synthetic-sharding', sgv: 120 + index })).status, 201);
    }
    if (apiOnly) { await seedEntries(); return { ns }; }
    if(!map){map = {count:2,workers:[]};
      for (const [ordinal,id] of ['a','b'].entries()) map.workers.push({ id, ordinal, address: { socket: path.join(directory, id + '.sock') }, consumerOrigin: 'http://127.0.0.1:' + await freePort() });}
    fs.writeFileSync(path.join(directory, 'realtime.json'), JSON.stringify(realtimeConfig), {mode:0o600});
    const internal = require('../../lib/server/internal-api/listener-config').resolve(['api'], { NS_SERVE_INTERNAL_SOCKET: path.join(directory, 'operator.sock') });
    slicePeers = ownership.peers({NS_REALTIME_SLICE_PEERS:JSON.stringify(map.workers.map(worker=>worker.address))},internal,{maxBytes:1048576,timeoutMs:5000});
    routeReader = Object.freeze({route:tenant=>({...slicePeers.route(tenant),consumerOrigin:map.workers[slice.bucket(tenant,2)].consumerOrigin})});
    if(operationState){
      apiService=http.createServer((req,res)=>{const upstream=http.request({socketPath:path.join(directory,'api.sock'),method:req.method,path:req.url,headers:req.headers,agent:false},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);});
      await new Promise(resolve=>apiService.listen(path.join(directory,'api-service.sock'),resolve));
      fs.chmodSync(path.join(directory,'api-service.sock'),0o600);
    }
    for (const sql of require('../../lib/tenant-registry/postgres').grants({ namespace: lab.namespaces.registry, resolvers: [lab.roles.realtime] })) await q(sql);
    // Evaluator private clients address the exact realtime ordinal directly.
    // No fixture proxy reports success or manufactures a durable receipt.
    producer=await require('./pgstream-native').setup({admin:lab.admin,adminURI:process.env.NS_TEST_POSTGRES_ADMIN_URI,directory,
      config:{...evaluatorConfig,namespaces:evaluatorConfig.postgres.namespaces},evaluatorRole:evaluator.name,realtimeRole:lab.roles.realtime,
      realtimeConfig:{...realtimeConfig,namespaces:realtimeConfig.postgres.namespaces},source:process.env});
    // Existing data at role boot must be inside the capture interval.
    await seedEntries();
    if (paused) for (const tenant of tenants) await activityWriter.transition({tenant,principal:'synthetic-operator',consumer:'native-proof'},'pause');
    fs.writeFileSync(path.join(directory,'evaluator.json'),JSON.stringify(evaluatorConfig),{mode:0o600});
    const evaluatorOperation=path.join(directory,'operation-evaluator.json');
    fs.writeFileSync(evaluatorOperation,JSON.stringify(operationState.base));
    const evaluatorEnvironment={...producer.environment,MULTITENANT_EVALUATOR_CONFIG:path.join(directory,'evaluator.json'),MULTITENANT_OPERATION_CONFIG:evaluatorOperation,
      EVAL_PG:evaluator.url,DISPLAY_PG:display.url,ACTIVITY_PG:activity.url,LIFETIME_PG:operationState.lifetime.url,
      NS_REALTIME_SLICE_PEERS:JSON.stringify(map.workers.map(worker=>worker.address)),NS_SERVE_INTERNAL_SOCKET:path.join(directory,'evaluator.sock'),NS_POOL_OPERATION_MAX:'2',NS_TENANT_READINESS:'all'};
    await preStart('evaluator',evaluatorEnvironment.MULTITENANT_EVALUATOR_CONFIG,evaluatorEnvironment);
    const evaluatorWorker=start('evaluator','evaluator',evaluatorEnvironment);
    // The owned producer is an independent actor; cold role bootstrap alone
    // cannot deliver later activity changes or committed clinical writes.
    await producer.start();
    await until(async()=>{assert.equal(evaluatorWorker.exit,null,'actual evaluator child refused: '+evaluatorWorker.stderr);try{return await require('../../lib/server/internal-api/clients').roleHealth({socketPath:path.join(directory,'evaluator.sock'),maxBytes:1048576,timeoutMs:5000}).getStatus({request:randomUUID()});}catch{return false;}},'actual evaluator operation endpoint');

    await startRealtime('a'); await startRealtime('b');
    edge = http.createServer((req, res) => {
      let target; try { const tenant = tenants.find(tenant => hosts.get(tenant) === req.headers.host); target = new URL(routeReader.route(tenant).consumerOrigin); } catch { res.writeHead(503); res.end(); return; }
      const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers, agent: false }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); }); req.pipe(upstream);
    });
    edge.on('connection', socket => { edgeSockets.add(socket); socket.on('close', () => edgeSockets.delete(socket)); });
    edge.on('upgrade', (req, socket, head) => {
      let target; try { const tenant = tenants.find(tenant => hosts.get(tenant) === req.headers.host); target = new URL(routeReader.route(tenant).consumerOrigin); } catch { socket.destroy(); return; }
      const upstream = net.connect(Number(target.port), target.hostname, () => { upstream.write(req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n' + Object.entries(req.headers).map(([name,value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    });
    await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
    // Stock node XHR derives Host from the URL (and overwrites extraHeaders).
    // Use real synthetic aliases including the lab listener port; only DNS is
    // mapped to loopback by the test agent, as a browser would resolve the site.
    for (const tenant of tenants) {
      const host = hosts.get(tenant) + ':' + edge.address().port;
      await q('INSERT INTO ' + quote(lab.namespaces.registry) + ".tenant_registry_hosts(host,tenant_id,kind) VALUES($1,$2,'alias')", [host, tenant]);
      hosts.set(tenant, host);
    }
    return { ns, internal };
  }
  async function provisionTenant (tenant, host) {
    hosts.set(tenant, host);
    const result = await provisioner.provision({ id: tenant, hosts: [host], issueRootSecret: true }); roots.set(tenant, result.rootSecret);
    const subject = 'synthetic-viewer';
    await q('INSERT INTO ' + quote(lab.namespaces.legacy) + '.legacy_credential_subjects VALUES($1,$2,$3)', [tenant, subject, 'viewer']);
    await q('INSERT INTO ' + quote(lab.namespaces.authorization) + '.tenant_authorization_subjects(tenant_id,subject_id,display_name) VALUES($1,$2,$3)', [tenant, subject, 'Synthetic Viewer']);
    await q('INSERT INTO ' + quote(lab.namespaces.authorization) + ".tenant_authorization_roles(tenant_id,name,permissions) VALUES($1,'viewer',ARRAY['*'])", [tenant]);
    await q('INSERT INTO ' + quote(lab.namespaces.authorization) + ".tenant_authorization_subject_roles VALUES($1,$2,'viewer')", [tenant, subject]);
    credentials.set(tenant, 'viewer-' + hash(hash(result.rootSecret) + subject).slice(0, 16));
    if (edge) {
      const alias = host + ':' + edge.address().port;
      await q('INSERT INTO ' + quote(lab.namespaces.registry) + ".tenant_registry_hosts(host,tenant_id,kind) VALUES($1,$2,'alias')", [alias, tenant]);
      hosts.set(tenant, alias); tenants.push(tenant);
    }
    return tenant;
  }
  async function cleanup () {
    await floorVerifier?.close();
    if (directory) for (const file of fs.readdirSync(directory).filter(name=>name.startsWith('hold-') || name.startsWith('fail-'))) fs.unlinkSync(path.join(directory,file));
    for (const socket of edgeSockets) socket.destroy(); if (edge) await new Promise(resolve => edge.close(resolve));
    for (const child of [...children]) await stop(child).catch(() => {});
    await producer?.close();
    if(apiService)await new Promise(resolve=>apiService.close(resolve));
    await activityWriter?.close().catch(() => {});
    await provisioner?.close().catch(() => {});
    if (lab) { for (const ns of schemas.reverse()) await q('DROP SCHEMA IF EXISTS ' + quote(ns) + ' CASCADE').catch(() => {}); for (const name of roles) { await q('DROP OWNED BY ' + quote(name)).catch(() => {}); await q('DROP ROLE IF EXISTS ' + quote(name)).catch(() => {}); } await lab.close(); }
    if (directory) fs.rmSync(directory, { recursive: true, force: true }); scope.setTenancyMode(previousMode);
  }
  return { setup, cleanup, request, startRealtime, stop, until, provisionTenant, setActivity: (tenant,verb) => activityWriter.transition({tenant,principal:'synthetic-operator',consumer:'native-proof'},verb),
    async unrelatedScopeControl () {
      await q('GRANT SELECT ON ' + quote(lab.namespaces.registry) + '.tenant_registry TO ' + quote(lab.roles.realtime));
      try { await assert.rejects(lastScreen(), error => error.code === 'PLATFORM_VERIFICATION_FAILED' &&
        error.verificationDiagnostic.causeCode === 'EVALUATOR_SCOPE_UNSAFE' && error.verificationDiagnostic.targetRole === 'realtime'); }
      finally { await q('REVOKE SELECT ON ' + quote(lab.namespaces.registry) + '.tenant_registry FROM ' + quote(lab.roles.realtime)); }
      await lastScreen();
    }, tenants, roots, credentials, hosts, workers,
    async closeProvisioner () {await provisioner?.close();provisioner=null;}, get lab () { return lab; }, get evaluator () { return evaluator; }, get publisher () { return publisher; }, get map () { return map; }, set map (value) { map = value; }, get directory () { return directory; }, get peers () { return slicePeers; }, get routes () { return routeReader; }, get edgePort () { return edge.address().port; }, get api () { return api; }, get apiInternal () { return { socketPath: path.join(directory,'api.sock'),maxBytes:1048576,timeoutMs:5000 }; } };
};
