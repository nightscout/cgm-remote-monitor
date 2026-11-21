'use strict';
// Root-provisioned actual role recovery slice. Broader all6/provider/browser
// acceptance remains separate explicitly registered joined-campaign criteria.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
module.exports = async function joined (input) {
  const roles = await require('./roles').start(input), config = roles.config, sockets = [], observations = [];
  const { Client } = require('pg'); const admin = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI });
  let connected = false, grantRows,storage;
  const write = () => fs.writeFileSync(path.join(input.captureDir, 'joined-recovery-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  const table = name => { assert.match(name, /^[a-z][a-z0-9_]{0,62}$/); return '"' + name + '"'; };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait (check, label) {
    const until = Date.now() + config.timeoutMs;
    while (Date.now() < until) { const value = await check(); if (value) return value; await pause(10); }
    throw new Error(label);
  }
  async function client (transport, namespace = '/', host = config.host, credentialEnv = config.credentialEnv) {
    const socket = roles.client({host,namespace,transports:[transport]});
    sockets.push(socket); const frames = []; socket.on('dataUpdate', frame => frames.push(frame));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('JOINED_AUTHORIZE_NOACK')), config.timeoutMs);
      socket.emit(namespace === '/' ? 'authorize' : 'subscribe', JSON.parse(input.env[credentialEnv]), value => { clearTimeout(timer); resolve(value); });
    });
    return { socket, frames, reply };
  }
  async function storageConnect({transport,namespace,host}) {
    assert.equal(namespace,'/storage');
    const socket=roles.client({host,namespace,transports:[transport]});
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',error=>{socket.close();reject(error);});});
    return socket;
  }
  try {
    assert.equal(roles.owned.tenant, config.tenant); assert.equal(roles.owned.entriesNamespace, config.entriesNamespace);
    assert.equal(roles.owned.authorizationNamespace, config.authorizationNamespace);
    assert(Number.isSafeInteger(config.observationMs) && config.observationMs > 0 && config.observationMs <= 60000);
    await require('./reader-grants')({ config, owned: roles.owned, captureDir: input.captureDir, env: input.env });
    await admin.connect(); connected = true;
    assert.equal(roles.owned.foreignTenant, config.foreignTenant);
    assert(config.foreignTenant !== config.tenant && config.foreignHost !== config.host);
    const realtimeEnv = require('./roles').roleEnvironment(JSON.parse(fs.readFileSync(config.realtimeEnvFile, 'utf8')), input.env);
    const realtimeConfig = require('../../../lib/server/realtime/config').parse(JSON.parse(fs.readFileSync(realtimeEnv.MULTITENANT_REALTIME_CONFIG, 'utf8')), realtimeEnv);
    const evaluatorConfig=require('../../../lib/server/serve/evaluator-config');
    const stored=(await admin.query('SELECT s.tenant_id,s.version,s.values,p.generation,p.policy FROM "'+config.settingsNamespace+'".tenant_settings s JOIN "'+config.operatorPolicyNamespace+'".tenant_operator_policy p USING(tenant_id) WHERE tenant_id=ANY($1::uuid[]) ORDER BY tenant_id',[[config.tenant,config.foreignTenant]])).rows;
    assert.equal(stored.length,2);assert.deepEqual(stored[0].values,stored[1].values,'equal committed settings keep tenant isolation control discriminating');
    const identities=stored.map(row=>evaluatorConfig.applySettings(evaluatorConfig.registryEntry(row.tenant_id),require('../../../lib/tenant-settings/component').resolveEffectiveSettings({version:row.version,values:row.values},{...row.policy,generation:row.generation})));
    assert.equal(identities[0].identity,identities[1].identity,
      'native isolation fixture needs equal effective config identities so an identity mismatch cannot mask a broken tenant filter');
    storage=await require('./storage-proof')({input,roles,admin,connect:storageConnect,realtimeConfig});
    const clients = [], foreignClients = [];
    for (const transport of ['polling', 'websocket']) {
      const item = await client(transport); clients.push(item);
      const frame = await wait(() => item.frames.find(row => row.delta === false && row.sgvs.some(sgv => sgv.mgdl === config.syntheticMgdl)), 'JOINED_INITIAL_TYPED_FRAME_MISSING');
      observations.push({ transport, admitted: item.reply.read, delta: frame.delta, sgvs: frame.sgvs }); write();
      assert.equal(item.reply.read, true);
      assert.equal(frame.sgvs.some(row => row.mgdl === config.foreignSyntheticMgdl), false, 'JOINED_TENANT_ROOM_NO_FOREIGN_SGV');
      const foreign = await client(transport, '/', config.foreignHost, config.foreignCredentialEnv); foreignClients.push(foreign);
      const foreignFrame = await wait(() => foreign.frames.find(row => row.sgvs.some(sgv => sgv.mgdl === config.foreignSyntheticMgdl)), 'JOINED_FOREIGN_TENANT_FRAME_MISSING');
      assert.equal(foreignFrame.sgvs.some(row => row.mgdl === config.syntheticMgdl), false, 'JOINED_FOREIGN_ROOM_NO_A_SGV');
    }
    await storage.exercise();
    // Supported hard deletion commits through the source clock. The resulting
    // completed evaluator output must replace the actual public frame with absence.
    const before = (await admin.query('SELECT last_stamp FROM ' + table(config.clockNamespace) + '.tenant_write_clock WHERE tenant_id=$1', [config.tenant])).rows;
    await require('./clock-write')({admin,namespace:config.clockNamespace,tenant:config.tenant,deleted:true},()=>admin.query('DELETE FROM '+table(config.entriesNamespace)+'.entries WHERE tenant_id=$1',[config.tenant]));
    const after = (await admin.query('SELECT last_stamp FROM ' + table(config.clockNamespace) + '.tenant_write_clock WHERE tenant_id=$1', [config.tenant])).rows;
    assert(BigInt(after[0].last_stamp)>BigInt(before[0].last_stamp),'JOINED_SUPPORTED_DELETE_CLOCK_ADVANCED');
    for (const item of clients) await wait(() => item.frames.some(row => row.delta === false && row.sgvs.length === 0), 'JOINED_QUIET_ABSENCE_BACKSTOP_FAILED');
    for (const foreign of foreignClients) assert(foreign.frames.at(-1).sgvs.some(row => row.mgdl === config.foreignSyntheticMgdl), 'JOINED_FOREIGN_TENANT_UNCHANGED');
    observations.push({ supportedRemoval:true,clockAdvanced:true, fullAbsence: true }); write();
    const reconnected = await client('polling');
    await wait(() => reconnected.frames.some(row => row.delta === false && row.sgvs.length === 0), 'JOINED_RECONNECT_ABSENCE_FAILED');
    const auth = table(config.authorizationNamespace);
    grantRows = (await admin.query('SELECT role_name FROM ' + auth + '.tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id=$2', [config.tenant, config.subjectId])).rows;
    assert(grantRows.length > 0, 'fixture subject must have explicit removable grants');
    await admin.query('DELETE FROM ' + auth + '.tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id=$2', [config.tenant, config.subjectId]);
    const prior = reconnected.frames.length;
    await storage.afterRevocation();
    await pause(config.observationMs);
    assert.equal(reconnected.frames.length, prior, 'JOINED_CACHED_AUTHORITY no protected frame after grant tightening');
    observations.push({ tightened: true, noProtectedDelivery: true }); write();
    // Browser is driven by root's real-browser phase through this unchanged
    // same-origin UI fixture; source-only preparation does not execute it here.
    if (config.uiFixture) observations.push({ ui: 'controlled actual-page fixture; product API remains headless', originPort: roles.ingress.port });
  } finally {
    const cleanup = [];
    for (const socket of sockets) socket.close();
    if(storage)try{await storage.close();}catch{cleanup.push('STORAGE_CLOSE_FAILED');}
    try {
      if (connected && grantRows) for (const row of grantRows) await admin.query('INSERT INTO ' + table(config.authorizationNamespace) +
        '.tenant_authorization_subject_roles(tenant_id,subject_id,role_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [config.tenant, config.subjectId, row.role_name]);
    } catch (error) { cleanup.push(error.code || 'GRANT_RESTORE_FAILED'); }
    try { await admin.end(); } catch { cleanup.push('ADMIN_CLOSE_FAILED'); }
    try { await roles.close(); } catch { cleanup.push('ROLE_CLOSE_FAILED'); }
    observations.push({ cleanupErrors: cleanup }); write();
    assert.equal(cleanup.length, 0, 'JOINED_EXACT_OWNED_CLEANUP');

  }
};
