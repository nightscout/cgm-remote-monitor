'use strict';

// Native-only inherited IPC driver over the actual selected role; no public API.
let running, context, startup;
const encode = value => JSON.parse(JSON.stringify(value));
const failure = (error, depth = 0) => ({ name: error.name, message: error.message, ...(depth < 3 && Array.isArray(error.errors) ? { errors: error.errors.map(item => failure(item, depth + 1)) } : {}) });
// Report rejected native transaction receipts through inherited fixture IPC.
// Only error metadata crosses this diagnostic seam; no clinical payload does.
const receiverPath=require.resolve('../../lib/pgstream/receiver'),receiver=require(receiverPath);
require.cache[receiverPath].exports={...receiver,create(options){
  const receive=receiver.create(options);
  return async event=>{try{return await receive(event);}catch(error){if(process.connected)process.send({nativeFailure:failure(error)});throw error;}};
}};
const currentOutput = tenant => context.health().closed || running.operationCohort.window.closed ? null
  : running.operationCohort.window.run(tenant, () => context.last(tenant));
process.on('message', async request => {
  try {
    let value;
    if (request.action === 'acquire') { await context.acquire(request.tenant); value = await currentOutput(request.tenant); }
    else if (request.action === 'tick') { await context.tick(request.tenant); value = await currentOutput(request.tenant); }
    else if (request.action === 'wake') { await context.consumerWake(request.tenant); value = context.health(); }
    else if (request.action === 'retry') { await context.consumerRetry(request.tenant); value = context.health(); }
    else if (request.action === 'flush') { await context.consumerFlush(request.tenant); value = context.health(); }
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
  const configured = require('../../lib/cli/commands/multitenant').configure(['evaluator'], process.env);
  running = await require('../../lib/server/serve').start(['evaluator'], { HOSTNAME: '127.0.0.1', PORT: 1337 }, null,
    process.env, configured);
  context = running.contexts.evaluator;
  process.send({ ready: true, health: context.health(), servers: running.servers.length });
})().catch(error => { process.send({ bootError: { name: error.name, message: error.message } }); process.disconnect(); process.exitCode = 1; });
process.once('SIGTERM', async () => { await startup; if (running) await running.stop(); if (process.connected) process.disconnect(); });
