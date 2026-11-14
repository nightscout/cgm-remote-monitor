'use strict';

// Private native fixture driver over the actual role composition, not a product
// listener or control API. IPC is inherited only by the explicitly forked test.
const pg = require('pg');
const query = pg.Client.prototype.query;
let held, release, armed = false, running, context, starting;
const encode = value => JSON.parse(JSON.stringify(value, (key, item) => item === undefined
  ? { probeType: 'undefined' } : typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))
    ? { probeType: 'number', value: Object.is(item, -0) ? '-0' : String(item) } : item));
pg.Client.prototype.query = function (...args) {
  const result = query.apply(this, args);
  // The cycle's actual clinical statistics read, after input COMMIT. Receipt
  // batch SQL also uses jsonb_to_recordset and must not satisfy this hold.
  if (armed && typeof args[0] === 'string' && args[0].includes('pg_column_size(doc)') && result?.then) {
    armed = false;
    return result.then(async value => {
      held = true; process.send({ held: true });
      await new Promise(done => { release = done; }); return value;
    });
  }
  return result;
};
const failure = (error, depth = 0) => ({ name: error.name, message: error.message, ...(depth < 3 && Array.isArray(error.errors) ? { errors: error.errors.map(item => failure(item, depth + 1)) } : {}) });
const currentOutput = tenant => context.health().closed || running.operationCohort.window.closed ? null
  : running.operationCohort.window.run(tenant, () => context.last(tenant));
process.on('message', async request => {
  try {
    let value;
    if (request.action === 'arm') { armed = true; value = true; }
    else if (request.action === 'release') { if (release) release(); value = !!held; }
    else if (request.action === 'acquire') { await context.acquire(request.tenant); value = await currentOutput(request.tenant); }
    else if (request.action === 'tick') { await context.tick(request.tenant); value = await currentOutput(request.tenant); }
    else if (request.action === 'last') value = await currentOutput(request.tenant);
    else if (request.action === 'health') value = context.health();
    else if (request.action === 'current') value = await context.isCurrent(request.tenant, request.identity);
    else if (request.action === 'close') { await running.stop(); value = true; }
    else if (request.action === 'exit') { process.disconnect(); process.exitCode = 0; return; }
    else throw new Error('Unknown fixture action');
    process.send({ id: request.id, value: encode(value) });
  } catch (error) { process.send({ id: request.id, error: failure(error) }); }
});
starting = (async () => {
  const configured = require('../../lib/cli/commands/multitenant').configure(['evaluator'], process.env);
  running = await require('../../lib/server/serve').start(['evaluator'], { HOSTNAME: '127.0.0.1', PORT: 1337 }, null,
    process.env, configured);
  context = running.contexts.evaluator;
  process.send({ ready: true, contexts: Object.keys(running.contexts), servers: running.servers.length,
    health: context ? context.health() : null });
})().catch(error => { process.send({ bootError: { name: error.name, message: error.message,
  previewConfigError: error instanceof require('../../lib/server/serve/preview-config').PreviewConfigError } }); process.disconnect(); process.exitCode = 1; });

process.once('SIGTERM', async () => {
  if (release) release();
  await starting;
  if (running) await running.stop();
  if (process.connected) process.disconnect();
});
