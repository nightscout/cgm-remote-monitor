'use strict';

// Actual selected evaluator role + restricted PG + actual protected UDS adapter.
// The receiving sink is controlled/synthetic, not actual browser authorization.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const base = require('./evaluator-preview-lab');
const connect = require('../../lib/storage/postgres-connection');
const { run } = require('../../lib/migrations/postgres');
const { createReceiver } = require('../../lib/tenant-alarms/composition');
const { createForwarder } = require('../../lib/server/tenant-socket-forwarding');
const ipc = require('../../lib/server/internal-api/transport');
const transport = require('../../lib/server/realtime/alarm-transport');
const clients = require('../../lib/server/internal-api/clients');
const ownership = require('../../lib/realtime-ownership').create({ count: 1, ordinal: 0 });
const parser = require('../../lib/server/serve/evaluator-config');
module.exports = function consumersLab () {
  const lab = base(), open = lab.open.bind(lab), reset = lab.reset.bind(lab), close = lab.close.bind(lab);
  const name = 'consumer_join_' + randomUUID().replace(/-/g, '').slice(0, 16), children = new Set();
  const outboxOwner = name + '_owner';
  const roles = { outbox: name + '_outbox', reader: name + '_reader', writer: name + '_writer' };
  const namespaces = { outbox: lab.name + '_outbox', alarm: lab.name + '_alarm' };
  let directory, source, sink, writer, configured, schemaReady = false;
  const createdRoles = new Set(), ownedSchemas = new Set(); const held = [];
  lab.consumerNamespaces = namespaces; lab.consumerRoles = roles; lab.observations = []; lab.sinkEffects = [];
  lab.sinkMode = 'accept';
  lab.open = async () => {
    await open(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-consumers-')); fs.chmodSync(directory, 0o700);
    const adminUrl = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
    const urls = {};
    for (const [kind, role] of Object.entries(roles)) {
      const password = randomBytes(24).toString('hex');
      await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`); createdRoles.add(role);
      const url = new URL(adminUrl); url.username = role; url.password = password; urls[kind] = url.toString();
    }
    for (const [namespace, catalogue] of [[namespaces.outbox, require('../../lib/tenant-notifications/postgres-candidate.json')],
      [namespaces.alarm, require('../../migrations/candidates/postgres-alarm-suppression-v1.json')]]) {
      await lab.admin.query('CREATE SCHEMA "' + namespace + '"');
      ownedSchemas.add(namespace);
      await run('up', {direct:true, connectionString:adminUrl.toString(), namespace, catalogue});
    }
    await lab.admin.query(`CREATE ROLE "${outboxOwner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    createdRoles.add(outboxOwner);
    for (const table of require('../../lib/tenant-notifications/partition-candidate').TABLES) {
      await lab.admin.query(`ALTER TABLE "${namespaces.outbox}"."${table}" OWNER TO "${outboxOwner}"`);
    }
    await lab.admin.query(`ALTER SCHEMA "${namespaces.outbox}" OWNER TO "${outboxOwner}"`);
    for (const sql of require('../../lib/server/ordinary-deployment-grants').notificationScheduleGrants({
      namespace:namespaces.outbox,owner:outboxOwner,outboxRole:roles.outbox,ackRole:roles.writer
    })) await lab.admin.query(sql);
    await lab.admin.query(`GRANT USAGE ON SCHEMA "${namespaces.outbox}" TO "${roles.outbox}"`);
    await lab.admin.query(`GRANT SELECT ON "${namespaces.outbox}".schema_migrations TO "${roles.outbox}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(request_id,blocked_until) ON "${namespaces.outbox}".tenant_notification_heads TO "${roles.outbox}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at) ON "${namespaces.outbox}".tenant_notification_requests TO "${roles.outbox}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(revision,config_identity,producer) ON "${namespaces.outbox}".tenant_notification_state TO "${roles.outbox}"`);
    await lab.admin.query(`GRANT USAGE ON SCHEMA "${namespaces.outbox}" TO "${roles.writer}"`);
    await lab.admin.query(`GRANT SELECT ON "${namespaces.outbox}".tenant_notification_state,"${namespaces.outbox}".schema_migrations TO "${roles.writer}"`);
    for (const role of [roles.reader, roles.writer]) await lab.admin.query(`GRANT USAGE ON SCHEMA "${namespaces.alarm}" TO "${role}"`);
    await lab.admin.query(`GRANT SELECT ON "${namespaces.alarm}".tenant_alarm_suppression,"${namespaces.alarm}".schema_migrations TO "${roles.reader}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(acked_at,expires_at) ON "${namespaces.alarm}".tenant_alarm_suppression TO "${roles.writer}"`);
    writer = await connect({ connectionString: urls.writer, max: 2, statement_timeout: 5000 });
    const receive = createReceiver({ connection: writer, namespace: namespaces.alarm,
      async admitAckInTransaction (operation) {
        if (!configured) throw new Error('Selected consumer config not yet bound');
        const linked = parser.loadMetadata({ ...lab.environment(configured), NS_ALARM_PG: urls.writer });
        const current = await linked.readCurrent(operation.operation.tenant, undefined, lab.registryAdmission);
        if (!current) throw new Error('Selected consumer tenant unavailable');
        return require('../../lib/tenant-notifications/ack-admission')({namespace:namespaces.outbox,consumer:linked.consumers.realtime.route.id,
          alarmNamespace:namespaces.alarm,maxRows:100,maxBytes:1048576,maxPayloadBytes:65536})({...operation,configIdentity:current.identity});
      },
      authenticateTransport: async request => request.syntheticTransport === true,
      resolveTenant: async request => request.tenant,
      authorizeSocket: async operation => operation.credential.id === operation.tenant ? { tenant: operation.tenant, principal: 'synthetic-authorized-owner' } : null,
      authorizeAckInTransaction: async operation => operation.credential.id === operation.tenant,
      executeWrite: async () => { throw new Error('Consumer fixture admits only owner ack'); } });
    lab.ack = (tenant = lab.A, level = 2, duration = 60000, group = 'default') => createForwarder({
      contextForSocket: async () => ({ tenant, credential: { id: tenant } }),
      transport: envelope => receive({ syntheticTransport: true, tenant }, envelope)
    }).forward({ socket: {}, namespace: '/alarm', event: 'ack', args: [level, group, duration] });
    source = { NS_OUTBOX_PG: urls.outbox, NS_SUPPRESSION_PG: urls.reader,
      NS_REALTIME_INTERNAL_SOCKET: path.join(directory, 'rt.sock') };
    await lab.setSettings({ enable: ['bgnow', 'delta', 'direction', 'simplealarms'] });
    for (const role of Object.values(roles)) await lab.grantOperationReader(role);
    lab.extraEnvironment = { ...lab.extraEnvironment, ...source };
    lab.document.consumers = require('../../lib/server/serve/deployment-settings').evaluator(lab.environment()).consumers;
    schemaReady = true;
  };
  lab.configureConsumers = change => {
    configured = lab.configure(change);
    return configured;
  };
  lab.writerConnection = () => writer;
  lab.epoch = async () => Number((await lab.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
  lab.producerState = async (tenant = lab.A) => (await lab.admin.query(`SELECT * FROM "${namespaces.outbox}".tenant_notification_state WHERE tenant_id=$1`, [tenant])).rows;
  lab.requests = async (tenant = lab.A) => (await lab.admin.query(`SELECT * FROM "${namespaces.outbox}".tenant_notification_requests WHERE tenant_id=$1 ORDER BY created_at,request_id`, [tenant])).rows;
  lab.suppressions = async (tenant = lab.A) => (await lab.admin.query(`SELECT * FROM "${namespaces.alarm}".tenant_alarm_suppression WHERE tenant_id=$1 ORDER BY alarm_group,alarm_level`, [tenant])).rows;
  lab.traceConsumer = (phase, value) => { const data = lab.encode({ phase, ...value }); lab.observations.push(data); console.log('M5_CONSUMER_OBSERVATION ' + JSON.stringify(data)); return data; };
  lab.deliverToSink = body => clients.alarmDelivery({ socketPath: source.NS_REALTIME_INTERNAL_SOCKET, maxBytes: 131072, timeoutMs: 1000 }).deliverAlarm(body);
  lab.openSink = async () => {
    if (sink) return;
    sink = await ipc.open({ socketPath: source.NS_REALTIME_INTERNAL_SOCKET, maxBytes: 131072, timeoutMs: 1000 }, require('../../lib/server/internal-api/contracts').alarmDelivery, token => {
      return { async deliverAlarm (request, body) {
        const rows = await lab.requests(body.tenant);
        lab.traceConsumer('sink-before-accept', { id: body.id, tenant: body.tenant, slice: body.slice, notification: body.notification,
          ownRow: rows.find(row => row.request_id === body.id) || null });
        // Correlate the accepted incoming boundary with actual delivery. The
        // product fanout intentionally carries only tenant + notification.
        // This fixture has one realtime receiver, matching the actual default
        // static routing contract. The receiver checks the producer's slice
        // before any controlled fanout effect; it never strips that identity.
        const real = transport.operations({ token, ownership, deliver: async operation => { lab.sinkEffects.push({ id: body.id, ...operation }); } });
        let accepted;
        try { accepted = await real.deliverAlarm(request, body); }
        catch (error) { lab.traceConsumer('sink-refused', { id: body.id, code: error.code || error.message }); throw error; }
        if (lab.sinkMode === 'hold') await new Promise(resolve => held.push(resolve));
        if (lab.sinkMode !== 'accept') throw new Error('Synthetic accepted handoff with lost response');
        return accepted;
      } };
    });
  };
  lab.releaseSink = () => { for (const release of held.splice(0)) release(); };
  lab.workerConsumers = async config => {
    return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'evaluator-consumer-worker.js'), config.args, {
      silent: true, detached: false, env: lab.environment(config) });
    const birthRaw = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8');
    const birthFields=birthRaw.slice(birthRaw.lastIndexOf(')')+2).trim().split(/\s+/);
    const birth=birthFields[19],processGroup=Number(birthFields[2]);
    child.fixtureBirth=birth;child.fixtureProcessGroup=processGroup;
    children.add(child); child.fixtureBootRefused = false; let sequence = 0, stdout = '', stderr = ''; const pending = new Map();
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const startup = setTimeout(() => {
      lab.traceConsumer('role-startup-watchdog', { phases: stdout.split('\n').filter(line => line.startsWith('Internal listener') || line.startsWith('Evaluator preview started')),
        pgstreamDiagnostics: stderr.split('\n').filter(line => line.startsWith('Pgstream ') || line.startsWith('Evaluator startup refused ')).slice(-8) });
      child.kill('SIGTERM'); reject(new Error('Consumer role startup watchdog'));
    }, 15000);
    const worker = { child, birth, processGroup, logs: () => ({ stdout, stderr }), call (action, tenant = lab.A) {
      // Demand admission: the same disposable hint the api sends after a write wakes the role for this tenant.
      if (action === 'acquire') lab.pendingBinding.hint(tenant);
      return new Promise((done, fail) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); fail(new Error('Consumer role IPC watchdog')); }, 15000);
        pending.set(id, { done, fail, timer }); child.send({ id, action, tenant }); });
    } };
    child.on('message', message => {
      if(message.nativeFailure){lab.traceConsumer('native-receipt-refused',message.nativeFailure);return;}
      if (message.ready || message.bootError) { child.fixtureBootRefused = !!message.bootError; if (message.bootError) lab.traceConsumer('role-boot-refusal', { ...message, pgstreamDiagnostics: stderr.split('\n').filter(line => line.startsWith('Pgstream ') || line.startsWith('Evaluator startup refused ')).slice(-8) }); clearTimeout(startup); resolve({ ...worker, startup: message }); }
      else if (pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.fail(Object.assign(new Error(message.error.message), { name: message.error.name })); else p.done(message.value); }
    });
    child.once('error', error => { clearTimeout(startup); reject(error); });
    child.on('exit', (code, signal) => { children.delete(child); clearTimeout(startup);
      for (const p of pending.values()) { clearTimeout(p.timer); p.fail(new Error('Consumer role exited with pending action')); } pending.clear();
      console.log('M5_CONSUMER_CHILD_EXIT ' + JSON.stringify({ pid: child.pid, code, signal })); });
  });
  };
  lab.killConsumer = worker => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error('Owned consumer already exited');
    const raw = fs.readFileSync('/proc/' + worker.child.pid + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[19] !== worker.birth || Number(fields[2]) !== worker.processGroup)
      throw new Error('Owned consumer process incarnation/group changed');
    process.kill(worker.child.pid, 'SIGKILL');
  };
  lab.stopConsumer = async worker => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    await worker.call('close'); const stopped = new Promise(resolve => worker.child.once('exit', (code, signal) => resolve({ code, signal })));
    worker.child.send({ id: 0, action: 'exit' }); return stopped;
  };
  lab.stopConsumers = async () => {
    const errors=[];
    lab.releaseSink();
    for (const child of [...children]) {
      const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      let forced = false;
      const timer = setTimeout(() => { forced = true; lab.killConsumer({child,birth:child.fixtureBirth,processGroup:child.fixtureProcessGroup}); }, 10000); child.kill('SIGTERM'); const result = await stopped; clearTimeout(timer);
      if (forced || result.code !== 0 && !child.fixtureBootRefused) errors.push(new Error('Owned consumer shutdown refused/forced'));
    }
    if(errors.length)throw new globalThis.AggregateError(errors,'Consumer actors cleanup refused');
  };
  lab.reset = async () => {
    await lab.stopConsumers(); lab.releaseSink(); if (sink) await sink.close(); sink = null;
    await reset();
    if (!schemaReady) return; // base.open calls the overridden reset before extension preparation
    await lab.setSettings({ enable: ['bgnow', 'delta', 'direction', 'simplealarms'] });
    await lab.admin.query(`TRUNCATE "${namespaces.outbox}".tenant_notification_requests,"${namespaces.outbox}".tenant_notification_heads,"${namespaces.outbox}".tenant_notification_state,"${namespaces.alarm}".tenant_alarm_suppression`);
    lab.sinkEffects.length = 0; lab.observations.length = 0; lab.sinkMode = 'accept';
  };
  lab.close = async () => {
    schemaReady = false;
    const errors = [];
    const attempt = async fn => {try {await fn();} catch(error) {errors.push(error);}};
    await attempt(() => lab.stopConsumers()); lab.releaseSink();
    if (sink) await attempt(() => sink.close());
    if (writer) await attempt(() => writer.end());
    if (lab.admin) {
      for (const namespace of [...ownedSchemas].reverse()) await attempt(async () => {
        await lab.admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); ownedSchemas.delete(namespace);
      });
      for (const role of [...createdRoles].reverse()) await attempt(async () => {
        await lab.admin.query(`DROP OWNED BY "${role}"`); await lab.admin.query(`DROP ROLE IF EXISTS "${role}"`); createdRoles.delete(role);
      });
    }
    if (directory) await attempt(async () => fs.rmSync(directory, {recursive:true,force:true}));
    await attempt(() => close());
    if (errors.length) throw new globalThis.AggregateError(errors, 'Consumer fixture owned cleanup refused');
  };
  return lab;
};
