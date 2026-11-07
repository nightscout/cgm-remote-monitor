'use strict';

// Native-only inherited IPC driver over the actual selected role; no public API.
let running, context, startup;
const encode = value => JSON.parse(JSON.stringify(value));
process.on('message', async request => {
  try {
    let value;
    if (request.action === 'acquire') { await context.acquire(request.tenant); value = context.last(request.tenant); }
    else if (request.action === 'tick') { await context.tick(request.tenant); value = context.last(request.tenant); }
    else if (request.action === 'wake') { await context.consumerWake(request.tenant); value = context.health(); }
    else if (request.action === 'retry') { await context.consumerRetry(request.tenant); value = context.health(); }
    else if (request.action === 'flush') { await context.consumerFlush(request.tenant); value = context.health(); }
    else if (request.action === 'health') value = context.health();
    else if (request.action === 'last') value = context.last(request.tenant);
    else if (request.action === 'close') { await running.stop(); value = true; }
    else if (request.action === 'exit') { process.disconnect(); process.exitCode = 0; return; }
    else throw new Error('Unknown native consumer action');
    process.send({ id: request.id, value: encode(value) });
  } catch (error) { process.send({ id: request.id, error: { name: error.name, message: error.message } }); }
});
startup = (async () => {
  const config = require('../../lib/server/serve/evaluator-config').load(process.env);
  running = await require('../../lib/server/serve').start(['evaluator'], { HOSTNAME: '127.0.0.1', PORT: 1337 }, null,
    process.env, { evaluatorPreview: config });
  context = running.contexts.evaluator;
  process.send({ ready: true, health: context.health(), servers: running.servers.length });
})().catch(error => { process.send({ bootError: { name: error.name, message: error.message } }); process.disconnect(); process.exitCode = 1; });
process.once('SIGTERM', async () => { await startup; if (running) await running.stop(); if (process.connected) process.disconnect(); });
