'use strict';

// Private native fixture driver over the actual role composition, not a product
// listener or control API. IPC is inherited only by the explicitly forked test.
let held, release, armed = false, running, context, starting;
// Count actual role queries without changing their result or timing contract.
const clinicalReads={snapshots:0,statistics:0,catalogue:0,exports:0,imports:0};
const pg=require('pg'),query=pg.Client.prototype.query;
pg.Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(typeof sql==='string'){
    if(sql.startsWith('CREATE_REPLICATION_SLOT ')&&sql.includes(' TEMPORARY '))clinicalReads.exports++;
    if(sql.startsWith('SET TRANSACTION SNAPSHOT '))clinicalReads.imports++;
    if(sql.includes('snapshot_source'))clinicalReads.snapshots++;
    if(sql.includes('pg_column_size(doc)'))clinicalReads.statistics++;
    if(sql.includes('information_schema.columns'))clinicalReads.catalogue++;
  }
  return query.apply(this,args);
};
const encode = value => JSON.parse(JSON.stringify(value, (key, item) => item === undefined
  ? { probeType: 'undefined' } : typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))
    ? { probeType: 'number', value: Object.is(item, -0) ? '-0' : String(item) } : item));
// Hold the actual clinical result before durable completion. Warm stream cycles
// intentionally do not execute the old full-source statistics SELECT; that SQL
// is no longer a valid clinical execution probe.
// Native negative control only: restore the old ready-input write lock in
// memory, leaving the actual default CLI composition and source tree intact.
if(process.env.NS_EVALUATOR_FIXTURE_WARM_LOCK_MUTANT==='1'){
  const file=require.resolve('../../lib/storage/postgres-durable-replay'),source=require('node:fs').readFileSync(file,'utf8');
  const needle="checkpointSelect + (stream ? '' : ' FOR UPDATE')";
  if(!source.includes(needle))throw Error('WARM_LOCK_CONTROL_SEAM_MISSING');
  require(file);const module={exports:{}};
  require('node:vm').runInThisContext('(function(require,module,exports){'+source.replace(needle,"checkpointSelect + ' FOR UPDATE'")+'\n})',{filename:file})(require('node:module').createRequire(file),module,module.exports);
  require.cache[file].exports=module.exports;
}
const evaluatorPath = require.resolve('../../lib/data/tenant-projection-evaluator');
const evaluator = require(evaluatorPath);
require.cache[evaluatorPath].exports = Object.assign((...args) => {
  const engine = evaluator(...args);
  return Object.freeze({...engine, async evaluate(options) {
    let result;try{result=await engine.evaluate(options);}catch(error){process.send({clinicalFailure:failure(error)});throw error;}
    if(armed){armed=false;held=true;process.send({held:true});await new Promise(done=>{release=done;});}
    return result;
  }});
},evaluator);
const failure = (error, depth = 0) => ({ name: error.name, message: error.message, ...(Array.isArray(error.predicates)?{predicates:error.predicates}:{}), ...(depth<3&&error.cause?{cause:failure(error.cause,depth+1)}:{}), ...(depth < 3 && Array.isArray(error.errors) ? { errors: error.errors.map(item => failure(item, depth + 1)) } : {}) });
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
    else if (request.action === 'queries') value = {...clinicalReads};
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
})().catch(error => { process.send({ bootError: { ...failure(error),
  previewConfigError: error instanceof require('../../lib/server/serve/preview-config').PreviewConfigError } }); process.disconnect(); process.exitCode = 1; });

process.once('SIGTERM', async () => {
  if (release) release();
  await starting;
  if (running) await running.stop();
  if (process.connected) process.disconnect();
});
