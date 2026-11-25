'use strict';

// Native-only inherited IPC driver over the actual selected role; no public API.
let running, context, startup;
const encode = value => JSON.parse(JSON.stringify(value));
const failure = (error, depth = 0) => ({ name: error.name, message: error.message, ...(depth < 3 && Array.isArray(error.errors) ? { errors: error.errors.map(item => failure(item, depth + 1)) } : {}) });
// Count refusals at the real notification producer even when a later delivery
// succeeds before health is sampled.
let scopeRefusals = 0;
const producerPath = require.resolve('../../lib/tenant-notifications/producer');
const makeProducer = require(producerPath);
require.cache[producerPath].exports = Object.assign(options => {
  const producer = makeProducer(options);
  return { ...producer, async select(tenant) {
    try { return await producer.select(tenant); }
    catch (error) {
      if (error.code === 'LIFECYCLE_WINDOW_SCOPE_INVALID') scopeRefusals++;
      throw error;
    }
  } };
}, makeProducer);
// Every statement by pool application_name and leading SQL text (statement-cost harness).
const statements=new Map();
{const pg=require('pg'),query=pg.Client.prototype.query;
  pg.Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(typeof sql==='string'){const shape=(this.connectionParameters?.application_name||'unnamed')+' | '+sql.replace(/\s+/g,' ').trim().slice(0,160);statements.set(shape,(statements.get(shape)||0)+1);}
    return query.apply(this,args);};}
// Writer-driven input admits a tenant from its pending row (sweep) or a hint; the fixture's
// acquire and tick wait for that admission, then drive the same cycle the role schedules.
const admitted = async tenant => {
  const end = Date.now() + 5000;
  while (!context.health().tenants.some(row => row.tenant === tenant)) {
    // A paused or suspended tenant may stay unadmitted: the action then reports what the role holds.
    if (Date.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
};
const driven = async (tenant, action) => { if (await admitted(tenant)) await context[action](tenant); };
const currentOutput = tenant => context.health().closed || running.generationScope.closed ? null
  : running.generationScope.run(tenant, () => context.last(tenant));
process.on('message', async request => {
  try {
    let value;
    if (request.action === 'acquire') { await driven(request.tenant, 'acquire'); value = await currentOutput(request.tenant); }
    else if (request.action === 'tick') { await driven(request.tenant, 'tick'); value = await currentOutput(request.tenant); }
    else if (request.action === 'wake') { await context.consumerWake(request.tenant); value = context.health(); }
    else if (request.action === 'retry') { await context.consumerRetry(request.tenant); value = context.health(); }
    else if (request.action === 'flush') { await context.consumerFlush(request.tenant); value = context.health(); }
    else if (request.action === 'selectionScopeRefusals') value = scopeRefusals;
    else if (request.action === 'statements') value = Object.fromEntries(statements);
    else if (request.action === 'statementsReset') { value = Object.fromEntries(statements); statements.clear(); }
    else if (request.action === 'health') value = context.health();
    else if (request.action === 'invalidate') { await context.invalidateTenant(request.tenant); value = context.health(); }
    else if (request.action === 'last') value = await currentOutput(request.tenant);
    else if (request.action === 'close') { await running.stop(); value = true; }
    else if (request.action === 'exit') { process.disconnect(); process.exitCode = 0; return; }
    else throw new Error('Unknown native consumer action');
    process.send({ id: request.id, value: encode(value) });
  } catch (error) { process.send({ id: request.id, error: failure(error) }); }
});
startup = (async () => {
  const configured = require('./evaluator-native-configuration')(process.argv[2], process.env);
  running = await require('../../lib/server/serve').start(['evaluator'], { HOSTNAME: '127.0.0.1', PORT: 1337 }, null,
    process.env, configured);
  context = running.contexts.evaluator;
  process.send({ ready: true, health: context.health(), servers: running.servers.length });
})().catch(error => { process.send({ bootError: { name: error.name, message: error.message } }); process.disconnect(); process.exitCode = 1; });
process.once('SIGTERM', async () => { await startup; if (running) await running.stop(); if (process.connected) process.disconnect(); });
