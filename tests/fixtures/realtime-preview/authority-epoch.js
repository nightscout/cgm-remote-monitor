'use strict';
// Explicit actual-role native scenario. Fixed private API relay holds a real
// successful authority response; it never invents permissions or credentials.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
module.exports = async function authorityEpoch (input) {
  let roles,channel,runtime,admin,activityOriginal,armed,sequence=0;
  const sockets = [], observations = [], pending = new Set();
  const save = () => fs.writeFileSync(path.join(input.captureDir, 'actual-socket-epoch.json'), JSON.stringify(observations, null, 2) + '\n');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let actualApi, rtDocument, config, privateRead;
  const equivalent = (a, b) => require('node:util').isDeepStrictEqual(a, b);
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  function arm (namespace) {
    assert.equal(armed, undefined, 'one authority barrier at a time');
    armed = { namespace, held: deferred(), release: deferred() }; return armed;
  }
  async function wait (check, marker) {
    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) { const found = check(); if (found) return found; await pause(10); }
    throw new Error(marker);
  }
  async function closeRelay () {
    if (armed) { armed.release.resolve(); armed = undefined; }
    if (channel) await channel.close();
    if (runtime) runtime.close();
  }
  async function setup ({ env, config: selected }) {
    config = selected; rtDocument = JSON.parse(fs.readFileSync(env.MULTITENANT_REALTIME_CONFIG, 'utf8'));
    const ipc = require('../../../lib/server/internal-api/transport');
    const service = require('../../../lib/server/internal-api/contracts').socketAuthority;
    actualApi = require('../../../lib/server/internal-api/clients').socketAuthority({ socketPath: env.NS_API_INTERNAL_SOCKET, maxBytes: rtDocument.maxMessageBytes, timeoutMs: rtDocument.operationTimeoutMs });
    assert.match(config.activityNamespace,/^[a-z][a-z0-9_]{0,62}$/);
    admin=new(require('pg').Client)({connectionString:input.env.NS_TEST_POSTGRES_ADMIN_URI});await admin.connect();
    activityOriginal=(await admin.query('SELECT paused,suspended FROM "'+config.activityNamespace+'".tenant_activity WHERE tenant_id=$1',[config.tenant])).rows[0];
    assert(activityOriginal&&!activityOriginal.suspended,'actual provisioned activity required');
    runtime = require('./runtime-directory')({ captureDir: input.captureDir, phaseId: input.phaseId });
    const apiSocketPath = path.join(runtime.path, 'authority.sock');
    try {
      channel = await ipc.open({ socketPath: apiSocketPath, maxBytes: rtDocument.maxMessageBytes, timeoutMs: rtDocument.operationTimeoutMs }, service, token => ({
        async authorizeSocket (request, body) {
          assert.equal(request.transport, token);
          const result = await actualApi.authorizeSocket( body); const barrier = armed;
          const old = require('../../../lib/server/realtime/authority').credentialFor(body.namespace, JSON.parse(input.env[config.epochReadCredentialEnv]));
          if (barrier && body.namespace === barrier.namespace && body.tenant === config.tenant && equivalent(body.credential, old) && result.permissions?.read) {
            armed = undefined; observations.push({ kind: 'actual-authority-held', sequence: ++sequence, namespace: body.namespace, read: true, at: Date.now() }); save();
            // The operation has real current API permission. Only its response
            // is delayed while the SAME socket changes epoch/config.
            pending.add(barrier); barrier.held.resolve(); await barrier.release.promise; pending.delete(barrier);
            observations.push({ kind: 'actual-authority-released', namespace: body.namespace, at: Date.now() }); save();
          }
          return result;
        },
        async executeSocketMutation (request, body) { assert.equal(request.transport, token); return actualApi.executeSocketMutation( body); }
      }));
      privateRead = async (namespace, credential) => actualApi.authorizeSocket( { host: config.host, tenant: config.tenant, namespace,
        credential: require('../../../lib/server/realtime/authority').credentialFor(namespace, credential) });
      return { apiSocketPath, close: closeRelay };
    } catch (error) { await closeRelay(); throw error; }
  }
  async function client (namespace) {
    const socket = roles.client({namespace,transports:['websocket']});
    sockets.push(socket); const events = [];
    for (const name of ['dataUpdate', 'urgent_alarm', 'retroUpdate']) socket.on(name, value => events.push({ name, value }));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const authorize = credential => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('EPOCH_AUTHORIZE_DEADLINE')), config.timeoutMs);
      socket.emit(namespace === '/' ? 'authorize' : 'subscribe', { ...credential, status: false }, result => { clearTimeout(timer); resolve(result); });
    });
    const read = JSON.parse(input.env[config.epochReadCredentialEnv]), status = JSON.parse(input.env[config.epochStatusCredentialEnv]);
    const actual = await privateRead(namespace, read), denied = await privateRead(namespace, status);
    assert.equal(actual.permissions.read, true); assert.equal(denied.permissions.read, false, 'valid status-only actor required, not invalid credential/disconnect');
    if(actual.display)assert(['mg/dl','mmol'].includes(actual.display.units),'actual committed display must retain source wire shape');
    await authorize(read);
    if (namespace === '/') await wait(() => events.some(row => row.name === 'dataUpdate'), 'EPOCH_INITIAL_FRAME_REQUIRED');
    events.length = 0;
    return { socket, events, authorize: () => authorize(status) };
  }
  async function restoreOperator(){
    if(!admin||!activityOriginal)return;
    const result=await admin.query('UPDATE "'+config.activityNamespace+'".tenant_activity SET version=version+1,paused=$2,suspended=$3 WHERE tenant_id=$1',[config.tenant,activityOriginal.paused,activityOriginal.suspended]);
    assert.equal(result.rowCount,1,'owned activity row must remain provisioned');
  }

  try {
    roles = await require('./roles').start({ ...input, beforeRealtime: setup });
    assert.equal(roles.owned.tenant, config.tenant);
    assert.equal(roles.owned.activityNamespace,config.activityNamespace,'parent must attest actual mutable activity schema');
    assert(Number.isSafeInteger(config.epochObservationMs) && config.epochObservationMs > 0 && config.epochObservationMs <= 30000);
    // Main: actual independent backstop invokes current auth while client still
    // has read rights. New valid status-only credential increments socket epoch.
    const main = await client('/'), mainBarrier = arm('/');
    await wait(() => pending.has(mainBarrier), 'EPOCH_MAIN_BARRIER_NOT_EXERCISED');
    main.events.length = 0;
    const mainReply = await main.authorize(); assert.equal(mainReply.read, false); mainBarrier.release.resolve();
    await pause(config.epochObservationMs);
    observations.push({ kind: 'main-reauthorization', deniedRead: mainReply.read, protectedEvents: main.events }); save();
    assert.equal(main.events.length, 0, 'SOCKET_EPOCH_MAIN_OLD_AUTHORITY_DELIVERY'); main.socket.close();
    // Alarm: actual private RT handoff waits on actual API old permission.
    const alarm = await client('/alarm'), alarmBarrier = arm('/alarm');
    const alarmPromise = require('../../../lib/server/internal-api/clients').alarmDelivery({ socketPath: config.alarmSocketPath,
      maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs }).deliverAlarm( { tenant: config.tenant, id: require('node:crypto').randomUUID(),
      attempt: 1, notification: { level: 2, group: 'synthetic-epoch', message: 'Synthetic epoch' }, receipts: [] });
    // Attach rejection immediately; a setup deadline is not an epoch success.
    const alarmResult = alarmPromise.then(value => ({ value }), error => ({ error: error.code || error.message }));
    await wait(() => pending.has(alarmBarrier), 'EPOCH_ALARM_BARRIER_NOT_EXERCISED');
    alarm.events.length = 0;
    const alarmReply = await alarm.authorize(); assert.equal(alarmReply.success, true); alarmBarrier.release.resolve();
    const handoff = await alarmResult; await pause(config.epochObservationMs);
    observations.push({ kind: 'alarm-reauthorization', handoff, protectedEvents: alarm.events }); save();
    assert.equal(handoff.error, undefined, 'actual handoff must complete');
    assert.deepEqual(handoff.value, { accepted: true, receipt: null, clearedRequestIds: [] }, 'RT_SERVER_HANDOFF_ONLY');
    assert.equal(alarm.events.length, 0, 'SOCKET_EPOCH_ALARM_OLD_AUTHORITY_DELIVERY'); alarm.socket.close();
    // Activity: suspend the actual provisioned tenant AFTER old real API
    // admission and before post-await frame checks; no static allowlist remains.
    const configured = await client('/'), configBarrier = arm('/');
    await wait(() => pending.has(configBarrier), 'EPOCH_CONFIG_BARRIER_NOT_EXERCISED');
    configured.events.length = 0;
    const suspended=await admin.query('UPDATE "'+config.activityNamespace+'".tenant_activity SET version=version+1,suspended=true WHERE tenant_id=$1',[config.tenant]);assert.equal(suspended.rowCount,1);configBarrier.release.resolve();
    await pause(config.epochObservationMs);
    observations.push({ kind: 'operator-tightening', protectedEvents: configured.events }); save();
    assert.equal(configured.events.length, 0, 'SOCKET_CONFIG_EPOCH_STALE_FRAME_DELIVERY');
  } finally {
    for (const barrier of pending) barrier.release.resolve(); if (armed) armed.release.resolve();
    for (const socket of sockets) socket.close();
    const cleanup = [];
    try { await restoreOperator(); } catch { cleanup.push('OPERATOR_RESTORE'); }
    if (roles) try { await roles.close(); } catch { cleanup.push('ROLE_RELAY_CLOSE'); }
    else try { await closeRelay(); } catch { cleanup.push('RELAY_CLOSE'); }
    if(admin)try{await admin.end();}catch{cleanup.push('ACTIVITY_ADMIN_CLOSE');}
    observations.push({kind:'cleanup',errors:cleanup,operatorRestored:cleanup.length===0});save();
    assert.equal(cleanup.length, 0, 'EPOCH_OWNED_CLEANUP');
  }
};
