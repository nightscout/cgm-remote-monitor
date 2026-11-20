'use strict';

// Private native fixture driver over the actual role composition, not a product
// listener or control API. IPC is inherited only by the explicitly forked test.
let held, release, armed = false, armedTenant, armedExpected, armedNonce, running, context, starting;
// Count actual role queries without changing their result or timing contract.
const clinicalReads={snapshots:0,statistics:0,catalogue:0,exports:0,imports:0};
for(const key of Object.keys(clinicalReads))clinicalReads[key+'Completed']=0;
// Every statement by pool application_name and leading SQL text (statement-cost harness).
const statements=new Map();
const pg=require('pg'),query=pg.Client.prototype.query;
pg.Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text,access=[];
  if(typeof sql==='string'){
    if(sql.startsWith('CREATE_REPLICATION_SLOT ')&&sql.includes(' TEMPORARY '))access.push('exports');
    if(sql.startsWith('SET TRANSACTION SNAPSHOT '))access.push('imports');
    if(sql.includes('snapshot_source'))access.push('snapshots');
    if(sql.includes('pg_column_size(doc)'))access.push('statistics');
    if(sql.includes('information_schema.columns'))access.push('catalogue');
  }
  for(const key of access)clinicalReads[key]++;
  if(typeof sql==='string'){const pool=this.connectionParameters?.application_name||'unnamed',shape=pool+' | '+sql.replace(/\s+/g,' ').trim().slice(0,160);statements.set(shape,(statements.get(shape)||0)+1);}
  const completed=()=>{for(const key of access)clinicalReads[key+'Completed']++;};
  const callback=args[args.length-1];
  if(access.length&&typeof callback==='function')args[args.length-1]=function(error,...values){if(!error)completed();return callback.call(this,error,...values);};
  const result=query.apply(this,args);
  return access.length&&typeof callback!=='function'&&result?.then?result.then(value=>{completed();return value;}):result;
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
  // The warm read now runs on the read-only port, where PostgreSQL itself
  // refuses a row lock; the control restores the old writable snapshot too.
  const needle="checkpointSelect + (stream ? '' : ' FOR UPDATE')",port='stream ? connection.readOnlyTransaction(() => read()) : connection.snapshotTransaction(() => read())';
  if(!source.includes(needle)||!source.includes(port))throw Error('WARM_LOCK_CONTROL_SEAM_MISSING');
  require(file);const module={exports:{}};
  require('node:vm').runInThisContext('(function(require,module,exports){'+source.replace(needle,"checkpointSelect + ' FOR UPDATE'").replace(port,'connection.snapshotTransaction(() => read())')+'\n})',{filename:file})(require('node:module').createRequire(file),module,module.exports);
  require.cache[file].exports=module.exports;
}
// Native source-access control: force an actual imported source snapshot on
// every reconcile. The timer witness must turn red even if coverage is unchanged.
if(process.env.NS_EVALUATOR_FIXTURE_WARM_SOURCE_MUTANT==='1'){
  const file=require.resolve('../../lib/storage/postgres-durable-replay'),source=require('node:fs').readFileSync(file,'utf8');
  const needle='if (stream && cached && streamState?.ready && saved.contract_digest === snapshotDigest &&';
  if(!source.includes(needle))throw Error('WARM_SOURCE_CONTROL_SEAM_MISSING');
  require(file);const module={exports:{}};
  require('node:vm').runInThisContext('(function(require,module,exports){'+source.replace(needle,'if (false &&')+'\n})',{filename:file})(require('node:module').createRequire(file),module,module.exports);
  require.cache[file].exports=module.exports;
}
const evaluatorPath = require.resolve('../../lib/data/tenant-projection-evaluator');
const evaluator = require(evaluatorPath);
require.cache[evaluatorPath].exports = Object.assign((...args) => {
  const engine = evaluator(...args);
  return Object.freeze({...engine, async evaluate(options) {
    let result;try{result=await engine.evaluate(options);}catch(error){process.send({clinicalFailure:failure(error)});throw error;}
    const reading=armedExpected&&result.frame?.sgvs?.find(row=>row._id===armedExpected.id&&row.mgdl===armedExpected.value);
    if(armed && args[0].tenant === armedTenant && (!armedExpected||reading)){
      armed=false;held=true;process.send({held:true,tenant:args[0].tenant,nonce:armedNonce,checkpoint:result.checkpoint,
        reading:reading?{id:reading._id,value:reading.mgdl}:null});await new Promise(done=>{release=done;});
    }
    return result;
  }});
},evaluator);
const failure = (error, depth = 0) => ({ name: error.name, message: error.message, ...(Array.isArray(error.predicates)?{predicates:error.predicates}:{}), ...(depth<3&&error.cause?{cause:failure(error.cause,depth+1)}:{}), ...(depth < 3 && Array.isArray(error.errors) ? { errors: error.errors.map(item => failure(item, depth + 1)) } : {}) });
const currentOutput = tenant => context.health().closed || running.generationScope.closed ? null
  : running.generationScope.run(tenant, () => context.last(tenant));
process.on('message', async request => {
  try {
    let value;
    if (request.action === 'arm') { armedTenant = request.tenant; armedExpected=request.hold?.expected;armedNonce=request.hold?.nonce;armed = true; value = true; }
    else if (request.action === 'release') { if (release) release(); value = !!held; }
    else if (request.action === 'acquire') { await context.acquire(request.tenant); value = await currentOutput(request.tenant); }
    else if (request.action === 'tick') { await context.tick(request.tenant); value = await currentOutput(request.tenant); }
    else if (request.action === 'last') value = await currentOutput(request.tenant);
    else if (request.action === 'queries') value = {...clinicalReads};
    else if (request.action === 'statements') { value = Object.fromEntries(statements); if (request.reset) statements.clear(); }
    else if (request.action === 'health') value = context.health();
    else if (request.action === 'current') value = await context.isCurrent(request.tenant, request.identity);
    else if (request.action === 'close') { await running.stop(); value = true; }
    else if (request.action === 'exit') { process.disconnect(); process.exitCode = 0; return; }
    else throw new Error('Unknown fixture action');
    process.send({ id: request.id, value: encode(value) });
  } catch (error) { process.send({ id: request.id, error: failure(error) }); }
});
starting = (async () => {
  const configured = require('./evaluator-native-configuration')(process.argv[2], process.env);
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
