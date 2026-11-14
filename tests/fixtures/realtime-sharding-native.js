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
const placements = require('../../lib/realtime-placement');
const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
const projectionDomains = require('../../lib/data/tenant-projection-evaluator').domains;
const order = require('../../lib/server/tenant-socket-order-port').catalogues;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha1').update(value).digest('hex');
const quote = value => '"' + value + '"';
const freePort = () => new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
async function until (fn, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(25); } throw new Error('SHARD_NATIVE_WAIT: ' + label); }
module.exports = function fixture () {
  let lab, provisioner, directory, edge, previousMode, config, map, placementReader, routeReader;
  const roles = [], schemas = [], children = new Set(), workers = new Map(), roots = new Map(), credentials = new Map(), hosts = new Map(), edgeSockets = new Set();
  let api, activity, display, check, alarm, publisher, lastScreen, activityWriter, operationState, apiService, evaluator, producer, evaluatorConfig, realtimeConfig;
  const idlePeers=[];
  const tenants = [];
  while (tenants.length < 2) { const id = randomUUID(); if (placements.shard(id, 2) === tenants.length) tenants.push(id); }
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
  async function startRealtime (id) {
    const row = map.workers.find(worker => worker.id === id);
    const env = { MULTITENANT_REALTIME_CONFIG: path.join(directory, 'realtime.json'), MULTITENANT_REALTIME_PLACEMENT: path.join(directory, 'placement.json'),
      REALTIME_WORKER_ID: id, REALTIME_WORKER_INCARNATION: row.incarnation, RT_PG: lab.urls.realtime, DISPLAY_PG: display.url, ACTIVITY_PG: activity.url,
      NS_SHARD_WARM_CONTROL_DIR: directory, NODE_OPTIONS:'--require '+path.join(__dirname,'realtime-sharding-diagnostics.cjs')+' --require '+path.join(__dirname,'realtime-sharding-controls.cjs'),
      NS_API_INTERNAL_SOCKET: path.join(directory, 'api.sock'), NS_SERVE_INTERNAL_SOCKET: row.address.socket, REALTIME_HOSTNAME: '127.0.0.1', REALTIME_PORT: String(new URL(row.consumerOrigin).port), NS_TENANT_READINESS: 'all' };
    if(operationState){
      const file=path.join(directory,'operation-rt-'+id+'.json');
      fs.writeFileSync(file,JSON.stringify({...operationState.base,participantId:'rt-'+id}));
      Object.assign(env,{MULTITENANT_OPERATION_CONFIG:file,LIFETIME_PG:operationState.lifetime.url,NS_POOL_OPERATION_MAX:'2',NS_API_INTERNAL_SOCKET:path.join(directory,'api-service.sock')});
    }
    const parsed = require('../../lib/server/realtime/config').load(env);
    lastScreen = async () => {
      const pool=new (require('pg').Pool)({connectionString:operationState.lifetime.url,max:2});
      const window=require('../../lib/tenant-lifecycle/operation-window').create({namespace:lab.namespaces.control,lockRule:'tenant-id-sha256-v1',pool,trustedWorker:true});
      try { await require('../../lib/server/serve/evaluator-readiness')(parsed,{operationWindow:window}); }
      finally { await window.close();await pool.end(); }
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
    const apiNamespaces = { ...Object.fromEntries(domains.map(domain => [domain, ns[domain]])), clock: ns.clock, authorization: lab.namespaces.authorization, legacy: lab.namespaces.legacy, secrets: lab.namespaces.secrets };
    for (const name of Object.values(apiNamespaces)) { await q('GRANT USAGE ON SCHEMA ' + quote(name) + ' TO ' + quote(check.name)); await q('GRANT SELECT ON ' + quote(name) + '.schema_migrations TO ' + quote(check.name)); }
    await readerGrants(display, [lab.namespaces.settings, lab.namespaces.operatorPolicy]);
    for (const sql of require('../../lib/tenant-activity/postgres').grants({ namespace: lab.namespaces.control, reader: activity.name })) await q(sql);
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
      activity:{connectionEnv:'ACTIVITY_PG',namespace:lab.namespaces.control},pgstream:stream.configuration({prefix:'sr_'+lab.id,capability:stream.capability(process.env)})};
    realtimeConfig = {version:1,postgres:{connectionEnv:'RT_PG',namespaces:{clock:ns.clock,checkpoint:ns.checkpoint}},consumer:'realtime-sharding-native',maxRows:10000,maxBytes:1048576,maxTenants:100,
      registry:evaluatorConfig.registry,tenantSettings:presentation,trustedWorker,activity:{namespace:lab.namespaces.control},completedOutput:{namespace:ns.evaluatorCheckpoint,consumer:evaluatorConfig.consumer},
      maxMessageBytes:1048576,operationTimeoutMs:5000,authorizationRecheckMs:100,unauthorizedDeadlineMs:1000};
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
      activity: { connectionEnv: 'ACTIVITY_PG', namespace: lab.namespaces.control },
      socketForwarding: { maxTenants: 100, maxMessageBytes: 1048576, operationTimeoutMs: 5000, alarm: { connectionEnv: 'ALARM_PG', namespace: alarmNamespace } } };
    fs.writeFileSync(path.join(directory, 'api.json'), JSON.stringify(config), { mode: 0o600 });
    if(operation==='sharded'){
      map={version:1,rule:placements.RULE,shardCount:2,generation:1,owners:['a','b'],workers:[]};
      for(const id of ['a','b'])map.workers.push({id,incarnation:randomUUID(),address:{socket:path.join(directory,id+'.sock')},consumerOrigin:'http://127.0.0.1:'+await freePort()});
      fs.writeFileSync(path.join(directory,'placement.json'),JSON.stringify(map));
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
      const namespaces = [...new Set([...Object.values(apiNamespaces),lab.namespaces.settings,lab.namespaces.operatorPolicy,alarmNamespace,ns.evaluatorCheckpoint,ns.checkpoint])];
      const protectedNamespaces=require('../../lib/server/serve/operation-cohort').protectedNamespaces;
      const roleNamespaces={api:protectedNamespaces(config),evaluator:protectedNamespaces(evaluatorConfig),realtime:protectedNamespaces(realtimeConfig)};
      const participants = ['api','evaluator','realtime','tenant-admin'].map(role => ({ id: role, roles: [role], namespaces:[...new Set(roleNamespaces[role]||namespaces)].filter(name=>name!==lab.namespaces.control),
        maxMessageBytes: 1048576, timeoutMs: 5000, address: { socket: path.join(directory,role + '.sock') } }));
      if(operation==='sharded'){
        const rtNamespaces=[...new Set([ns.clock,ns.checkpoint,ns.evaluatorCheckpoint,lab.namespaces.settings,lab.namespaces.operatorPolicy])];
        participants.splice(participants.findIndex(row=>row.id==='realtime'),1,...map.workers.map(worker=>({id:'rt-'+worker.id,roles:['realtime'],worker:worker.id,namespaces:rtNamespaces,maxMessageBytes:1048576,timeoutMs:5000,address:worker.address})));
        operationState={lifetime,base:{version:2,namespace:lab.namespaces.control,connectionEnv:'LIFETIME_PG',registry:{namespace:lab.namespaces.registry},participants}};
        operationEnvironment.MULTITENANT_REALTIME_PLACEMENT=path.join(directory,'placement.json');
      }
      const file = path.join(directory,'operation-api.json');
      fs.writeFileSync(file,JSON.stringify({version:2,namespace:lab.namespaces.control,connectionEnv:'LIFETIME_PG',registry:{namespace:lab.namespaces.registry},participantId:'api',participants}));
      Object.assign(operationEnvironment,{MULTITENANT_OPERATION_CONFIG:file,LIFETIME_PG:lifetime.url,NS_POOL_OPERATION_MAX:'2',NODE_OPTIONS:'--require '+path.join(__dirname,'realtime-sharding-diagnostics.cjs')});
    }
    api = await ready(start('api', 'api', { ...operationEnvironment, MULTITENANT_PREVIEW_CONFIG: path.join(directory, 'api.json'), API_PG: lab.urls.api, CHECK_PG: check.url,
      DISPLAY_PG: display.url, ACTIVITY_PG: activity.url, ALARM_PG: alarm.url, VAULT_TOKEN: token,
      NS_SERVE_INTERNAL_SOCKET: path.join(directory, 'api.sock'), API_HOSTNAME: '127.0.0.1', API_PORT: '0', NS_TENANT_READINESS: 'all' }), 'api');
    for (const [index, tenant] of tenants.entries()) assert.equal((await request(tenant, 'POST', '/api/v3/entries', { identifier: 'shard-initial-' + index, type: 'sgv', date: Date.now(), utcOffset: 0, app: 'synthetic-sharding', sgv: 120 + index })).status, 201);
    if (apiOnly) return { ns };
    if(!map){map = { version: 1, rule: placements.RULE, shardCount: 2, generation: 1, owners: ['a','b'], workers: [] };
      for (const id of ['a','b']) map.workers.push({ id, incarnation: randomUUID(), address: { socket: path.join(directory, id + '.sock') }, consumerOrigin: 'http://127.0.0.1:' + await freePort() });}
    fs.writeFileSync(path.join(directory, 'placement.json'), JSON.stringify(map));
    fs.writeFileSync(path.join(directory, 'realtime.json'), JSON.stringify(realtimeConfig), {mode:0o600});
    const internal = require('../../lib/server/internal-api/listener-config').resolve(['api'], { NS_SERVE_INTERNAL_SOCKET: path.join(directory, 'operator.sock') });
    placementReader = placements.load({ MULTITENANT_REALTIME_PLACEMENT: path.join(directory, 'placement.json') }, { internal });
    fs.writeFileSync(path.join(directory,'routes.json'),JSON.stringify(map));
    routeReader = placements.loadRoutes({MULTITENANT_REALTIME_ROUTES:path.join(directory,'routes.json')},{internal});
    if(operationState){
      apiService=http.createServer((req,res)=>{const upstream=http.request({socketPath:path.join(directory,'api.sock'),method:req.method,path:req.url,headers:req.headers,agent:false},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);});
      await new Promise(resolve=>apiService.listen(path.join(directory,'api-service.sock'),resolve));
      fs.chmodSync(path.join(directory,'api-service.sock'),0o600);
      const template=await require('../../lib/server/internal-api/clients').lifecycleParticipant({socketPath:path.join(directory,'api.sock'),maxBytes:1048576,timeoutMs:5000}).getStatus({request:randomUUID()});
      for(const id of ['tenant-admin']){
        const peer=operationState.base.participants.find(row=>row.id===id),incarnation=randomUUID();
        // Explicit idle fixture peers: no clinical role/workload/backend is
        // attributed to them. Actual API+RT actors below remain authoritative.
        const status=()=>{const current=placementReader.current();return {...template,participant:id,roles:[id],incarnation,namespaces:[...peer.namespaces].sort(),backends:[],placement:{generation:current.generation,digest:current.digest,rule:current.rule,shardCount:current.shardCount,worker:null,incarnation:null,shards:[]}};};
        idlePeers.push(await require('../../lib/server/internal-api/transport').open({socketPath:peer.address.socket,maxBytes:1048576,timeoutMs:5000},require('../../lib/server/internal-api/contracts').lifecycleParticipant,()=>({getStatus:async(ctx,body)=>({...status(),request:body.request}),invalidateTenant:async(ctx,body)=>({...status(),request:body.request,tenant:body.tenant}),getOperations:async(ctx,body)=>({request:body.request,tenant:body.tenant,participant:id,incarnation,operations:[]})})));
      }
    }
    if (paused) for (const tenant of tenants) await activityWriter.transition({tenant,principal:'synthetic-operator',consumer:'native-proof'},'pause');
    // The addressed output hint follows the same placement authority as the
    // consumer, without touching payloads or manufacturing a durable receipt.
    idlePeers.push(await require('../../lib/server/internal-api/transport').open({socketPath:path.join(directory,'output.sock'),maxBytes:4096,timeoutMs:1000},
      require('../../lib/server/internal-api/contracts').completedOutput,()=>({hintCompletedOutput:async(ctx,body)=>{
        return require('../../lib/server/internal-api/clients').completedOutput(placementReader.route(body.tenant).endpoint).hintCompletedOutput(body);
      }})));
    producer=await require('./pgstream-native').setup({admin:lab.admin,adminURI:process.env.NS_TEST_POSTGRES_ADMIN_URI,directory,
      config:{...evaluatorConfig,namespaces:evaluatorConfig.postgres.namespaces},evaluatorRole:evaluator.name,realtimeRole:lab.roles.realtime,
      realtimeConfig:{...realtimeConfig,namespaces:realtimeConfig.postgres.namespaces},source:process.env});
    fs.writeFileSync(path.join(directory,'evaluator.json'),JSON.stringify(evaluatorConfig),{mode:0o600});
    const evaluatorOperation=path.join(directory,'operation-evaluator.json');
    fs.writeFileSync(evaluatorOperation,JSON.stringify({...operationState.base,participantId:'evaluator'}));
    const evaluatorWorker=start('evaluator','evaluator',{...producer.environment,MULTITENANT_EVALUATOR_CONFIG:path.join(directory,'evaluator.json'),MULTITENANT_OPERATION_CONFIG:evaluatorOperation,
      EVAL_PG:evaluator.url,DISPLAY_PG:display.url,ACTIVITY_PG:activity.url,LIFETIME_PG:operationState.lifetime.url,
      MULTITENANT_REALTIME_PLACEMENT:path.join(directory,'placement.json'),NS_SERVE_INTERNAL_SOCKET:path.join(directory,'evaluator.sock'),NS_REALTIME_INTERNAL_SOCKET:path.join(directory,'output.sock'),NS_POOL_OPERATION_MAX:'2',NS_TENANT_READINESS:'all'});
    await until(async()=>{assert.equal(evaluatorWorker.exit,null,'actual evaluator child refused: '+evaluatorWorker.stderr);try{return await require('../../lib/server/internal-api/clients').lifecycleParticipant({socketPath:path.join(directory,'evaluator.sock'),maxBytes:1048576,timeoutMs:5000}).getStatus({request:randomUUID()});}catch{return false;}},'actual evaluator operation endpoint');

    for (const sql of require('../../lib/tenant-registry/postgres').grants({ namespace: lab.namespaces.registry, resolvers: [lab.roles.realtime] })) await q(sql);
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
    if (directory) for (const file of fs.readdirSync(directory).filter(name=>name.startsWith('hold-') || name.startsWith('fail-'))) fs.unlinkSync(path.join(directory,file));
    for (const socket of edgeSockets) socket.destroy(); if (edge) await new Promise(resolve => edge.close(resolve));
    for (const child of [...children]) await stop(child).catch(() => {});
    await producer?.close();
    for(const peer of idlePeers)await peer.close();if(apiService)await new Promise(resolve=>apiService.close(resolve));
    await activityWriter?.close().catch(() => {});
    await provisioner?.close().catch(() => {});
    if (lab) { for (const ns of schemas.reverse()) await q('DROP SCHEMA IF EXISTS ' + quote(ns) + ' CASCADE').catch(() => {}); for (const name of roles) { await q('DROP OWNED BY ' + quote(name)).catch(() => {}); await q('DROP ROLE IF EXISTS ' + quote(name)).catch(() => {}); } await lab.close(); }
    if (directory) fs.rmSync(directory, { recursive: true, force: true }); scope.setTenancyMode(previousMode);
  }
  return { setup, cleanup, request, startRealtime, stop, until, provisionTenant, setActivity: (tenant,verb) => activityWriter.transition({tenant,principal:'synthetic-operator',consumer:'native-proof'},verb),
    async unrelatedScopeControl () {
      await q('GRANT SELECT ON ' + quote(lab.namespaces.registry) + '.tenant_registry TO ' + quote(lab.roles.realtime));
      try { await assert.rejects(lastScreen(), /unsafe evaluator scope/); }
      finally { await q('REVOKE SELECT ON ' + quote(lab.namespaces.registry) + '.tenant_registry FROM ' + quote(lab.roles.realtime)); }
      await lastScreen();
    }, tenants, roots, credentials, hosts, workers,
    get cohortParticipants () { return operationState?.base.participants.map(row=>({id:row.id,roles:row.roles,...(row.worker?{worker:row.worker}:{}),namespaces:row.namespaces,endpoint:{socketPath:row.address.socket,maxBytes:row.maxMessageBytes,timeoutMs:row.timeoutMs}})); }, async closeProvisioner () {await provisioner?.close();provisioner=null;}, get lab () { return lab; }, get evaluator () { return evaluator; }, get publisher () { return publisher; }, get map () { return map; }, set map (value) { map = value; }, get directory () { return directory; }, get placement () { return placementReader; }, get routes () { return routeReader; }, publishRoutes () { const temporary=path.join(directory,'routes.next.json');fs.copyFileSync(path.join(directory,'placement.json'),temporary);fs.renameSync(temporary,path.join(directory,'routes.json')); }, get edgePort () { return edge.address().port; }, get api () { return api; }, get apiInternal () { return { socketPath: path.join(directory,'api.sock'),maxBytes:1048576,timeoutMs:5000 }; } };
};
