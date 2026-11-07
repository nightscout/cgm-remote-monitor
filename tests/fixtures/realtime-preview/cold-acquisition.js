'use strict';
// Actual CLI clinical-refusal oracle. Inserts only through actual socket/API;
// observes actual CLI getters through the disclosed preload, never writes state.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function coldAcquisition ({ input, roles, admin, warm, alarmRoutePath, record, wait, sockets }) {
  const config = roles.config, selected = config.coldAcquisition;
  assert(selected && Number.isSafeInteger(selected.entryCount) && selected.entryCount > 0, 'explicit cold acquisition packet count required');
  const env = require('./roles').roleEnvironment(JSON.parse(fs.readFileSync(config.evaluatorEnvFile)), input.env);
  assert.equal(selected.evaluatorConfigFile, env.MULTITENANT_EVALUATOR_CONFIG);
  assert(Array.isArray(roles.owned.configurationFiles) && roles.owned.configurationFiles.includes(selected.evaluatorConfigFile), 'owned mutable evaluator fixture config required');
  assert.equal(env.NS_RT_EVALUATOR_OBSERVE, '1'); assert.equal(env.NS_RT_EVALUATOR_OBSERVATION_FILE, selected.observerFile);
  assert.equal(env.NS_RT_NATIVE_PHASE, input.phaseId); assert.equal(env.NS_RT_SOURCE_HEAD, input.env.NS_RT_SOURCE_HEAD);
  const preload = path.join(input.sourceDir, 'tests/fixtures/realtime-preview/observe-evaluator.js');
  assert.equal(env.NODE_OPTIONS, '--require=' + preload, 'only reviewed actual CLI getter preload allowed');
  const stat = fs.lstatSync(selected.evaluatorConfigFile), original = fs.readFileSync(selected.evaluatorConfigFile);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid());
  const document = JSON.parse(original), tenant = document.tenants.find(row => row.id === config.tenant);
  assert(tenant && typeof selected.revision === 'string' && selected.revision.length && selected.revision !== tenant.revision);
  assert(selected.entryCount > document.maxRows, 'real API rows must exceed evaluator acquisition bound');
  const realtime = require('./roles').roleEnvironment(JSON.parse(fs.readFileSync(config.realtimeEnvFile)), input.env);
  const rtConfig = JSON.parse(fs.readFileSync(realtime.MULTITENANT_REALTIME_CONFIG));
  assert(selected.entryCount + 1 <= rtConfig.maxRows, 'RT bound must support real cold-case packets');
  const restore = () => {
    const current = fs.lstatSync(selected.evaluatorConfigFile);
    assert(current.dev === stat.dev && current.ino === stat.ino && current.uid === stat.uid, 'cold fixture config ownership changed');
    fs.writeFileSync(selected.evaluatorConfigFile, original);
  };
  async function observe (pid, after = 0) {
    if (!fs.existsSync(selected.observerFile)) return;
    let actual; try { actual = JSON.parse(fs.readFileSync(selected.observerFile)); } catch { return; }
    if (actual.observedAt < after || actual.pid !== pid || actual.sourceHead !== input.env.NS_RT_SOURCE_HEAD || actual.phaseId !== input.phaseId) return;
    const health = actual.health.tenants.find(row => row.tenant === config.tenant), last = actual.last.find(row => row.tenant === config.tenant);
    if (health?.code === 'EVALUATOR_ACQUISITION_REFUSED' && last?.value === null) return actual;
  }
  try {
    const socket = require('socket.io-client')('http://127.0.0.1:' + roles.ingress.port, { transports: ['websocket'], forceNew: true,
      reconnection: false, timeout: config.timeoutMs, extraHeaders: { Host: config.host } }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const send = (event, ...args) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('COLD_API_' + event + '_NOACK')), config.timeoutMs);
      socket.emit(event, ...args, (...reply) => { clearTimeout(timer); resolve(reply); });
    });
    const authorized = await send('authorize', JSON.parse(input.env[config.dataCredentialEnv])); assert.equal(authorized[0]?.write, true);
    const packets = [], at = Date.now();
    for (let i = 0; i < selected.entryCount; i++) {
      const packet = { collection: 'entries', data: { _id: 'synthetic-cold-' + require('node:crypto').randomUUID(), type: 'sgv', sgv: 60,
        date: at + i, dateString: new Date(at + i).toISOString(), device: 'synthetic-cold-acquisition' } };
      const reply = await send('dbAdd', packet); packets.push({ packet, reply }); record({ coldPackets: packets });
    }
    assert.match(config.entriesNamespace, /^[a-z][a-z0-9_]{0,62}$/); assert.equal(roles.owned.entriesNamespace, config.entriesNamespace);
    const rows = (await admin.query('SELECT id_kind,doc FROM "' + config.entriesNamespace + '".entries WHERE tenant_id=$1', [config.tenant])).rows;
    record({ coldPhysicalRows: rows }); assert(rows.length > document.maxRows, 'COLD_ACTUAL_API_ACQUISITION_BOUND');
    await warm.close(); tenant.revision = selected.revision; fs.writeFileSync(selected.evaluatorConfigFile, JSON.stringify(document));
    const cold = await roles.startEvaluator({ alarmRoutePath });
    const beforeAck = await wait(() => observe(cold.pid), 'COLD_ACTUAL_CLI_REFUSAL_LAST_NULL_REQUIRED');
    record({ coldBeforeAck: beforeAck });
    return { pid: cold.pid, beforeAck, observe: after => observe(cold.pid, after), restore };
  } catch (error) { restore(); throw error; }
};
