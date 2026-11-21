'use strict';
// Equal synthetic canonical work through one and three independent API storage
// pool instances. This measures SQL/lock-boundary cost, not process capacity.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {execFileSync}=require('node:child_process'),{performance}=require('node:perf_hooks'),pg=require('pg');
const scope=require('../lib/storage/tenant-scope'),dates=require('../lib/server/srv-dates');
const fixture=require('./fixtures/tenant-commit-clock-port'),{optInSuite}=require('./support/opt-in');
const BASE='7aab0694470b92bb9a6478dd01fa057ee5fd33ef';
function isolated(relative,source,mocks={}){const file=path.resolve(__dirname,'../',relative),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);m.require=name=>Object.hasOwn(mocks,name)?mocks[name]:original(name);m._compile(source,file);return m.exports;}
function queryKind (sql) {
  if (sql.startsWith('BEGIN')) return 'begin';
  if (sql === 'COMMIT') return 'commit';
  if (/tenant_write_clock.*FOR UPDATE/s.test(sql)) return 'clock-select-lock';
  if (/^UPDATE .*tenant_write_clock/s.test(sql)) {
    return sql.endsWith('RETURNING last_stamp') ? 'clock-reserve' : 'clock-update';
  }
  return 'other';
}
const fromBase=relative=>execFileSync('git',['show',BASE+':'+relative],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'disposable clock fixture')('API history lock cost at one and three pool instances',function(){
 this.timeout(30000);
 for(const replicas of [1,3])it('retains canonical outcomes while removing non-history clock work with '+replicas+' instance(s)',async()=>{
  const lab=fixture({replicas}),original=pg.Client.prototype.query;let capture=null;
  try{
   await lab.open();
   // Load precisely the displaced clock/common/low-level record coupling. The
   // rest of the storage implementation is held equal to the candidate.
   const oldClock=isolated('lib/storage/postgres-write-clock.js',fromBase('lib/storage/postgres-write-clock.js'));
   const oldCommon=isolated('lib/storage/postgres-intent-common.js',fromBase('lib/storage/postgres-intent-common.js'));
   const oldWriter=isolated('lib/storage/postgres-entries-write.js',fromBase('lib/storage/postgres-entries-write.js'),{'../server/srv-dates':{recordWrite({deleted=false}={}){const allocator=dates.allocationContext();if(allocator)allocator.record(deleted);}}});
   const oldCollection=isolated('lib/storage/postgres-collection-intent.js',fs.readFileSync(require.resolve('../lib/storage/postgres-collection-intent'),'utf8'),{'./postgres-entries-write':oldWriter,'./postgres-intent-common':oldCommon});
   const oldEntries=isolated('lib/storage/postgres-entries-intent.js',fs.readFileSync(require.resolve('../lib/storage/postgres-entries-intent'),'utf8'),{'./postgres-entries-write':oldWriter,'./postgres-intent-common':oldCommon});
   pg.Client.prototype.query=function(...args){
    const own=capture&&this.connectionParameters.user===lab.role,started=performance.now(),sql=typeof args[0]==='string'?args[0]:args[0].text;
    const result=original.apply(this,args);
    if(own&&result?.then)result.then(()=>capture?.push({pid:this.processID,kind:queryKind(sql),started,ended:performance.now()}),()=>{});
    return result;
   };
   const reports=[];
   for(const arm of ['baseline-clock-coupling','history-only']){
    await lab.reset();const legacy=arm==='history-only'?require('../lib/storage/postgres-collection-intent'):oldCollection;
    const entries=arm==='history-only'?require('../lib/storage/postgres-entries-intent'):oldEntries;
    const clocks=lab.raw.map(raw=>arm==='history-only'?require('../lib/storage/postgres-write-clock')(raw,lab.namespaces.clock):oldClock(raw,lab.namespaces.clock));
    // Warm/observe actual backends before measuring the equal workload.
    for(const connection of lab.raw)await scope.withTenant(lab.A,()=>connection.query('SELECT 1'));
    const ports=clocks.map(connection=>({entries:entries({connection,table:lab.table}),activity:legacy({connection,table:lab.namespaces.activity+'.activity',logical:'activity',source:'v1/internal'})}));
    capture=[];const start=performance.now();
    await Promise.all(Array.from({length:6},async(_,i)=>scope.withTenant(lab.A,async()=>{
     const port=ports[i%replicas];
     await port.entries.write({op:'create',docs:[{identifier:'synthetic-cost-'+i,type:'sgv',sgv:123,date:1793923200000,utcOffset:0}]});
     await port.activity.write({op:'create',docs:[{_id:'activity-'+i,created_at:'2026-11-17T00:00:00.000Z',steps:i}]});
     await port.entries.write({op:'delete',form:'permanent',target:{identifier:'synthetic-cost-'+i}});
    })));
    const elapsedMs=performance.now()-start,observed=capture;capture=null;
    assert.equal((await lab.rows()).length,0);assert.equal((await lab.admin.query('SELECT count(*)::int AS n FROM "'+lab.namespaces.activity+'".activity')).rows[0].n,6);
    const counts = Object.fromEntries(['begin', 'commit', 'clock-select-lock', 'clock-reserve', 'clock-update', 'other']
      .map(kind => [kind, observed.filter(row => row.kind === kind).length]));
    const held = new Map(), holdMs = [], acquisitionMs = [];
    for (const row of observed.sort((a,b) => a.ended - b.ended)) {
      if (row.kind === 'clock-select-lock' || row.kind === 'clock-reserve') {
        held.set(row.pid, row.ended);
        acquisitionMs.push(row.ended - row.started);
      }
      if (row.kind === 'commit' && held.has(row.pid)) {
        holdMs.push(row.ended - held.get(row.pid));
        held.delete(row.pid);
      }
    }
    assert.equal(counts.begin,18);
    assert.equal(counts.commit,18);
    const current = arm === 'history-only';
    assert.equal(counts['clock-select-lock'], current ? 0 : 18);
    assert.equal(counts['clock-reserve'], current ? 6 : 0);
    assert.equal(counts['clock-update'], current ? 0 : 18);
    assert.equal(holdMs.length, current ? 6 : 18);
    reports.push({arm,replicas,workload:{historyCreates:6,activityCreates:6,physicalDeletes:6},counts,elapsedMs,
      clockAcquisitionElapsedMs:acquisitionMs,lockAcquiredToCommitAckMs:holdMs});
   }
   console.log('API_SQL_COST '+JSON.stringify({scope:'same-process independent API storage pools; no capacity claim',baselineModules:BASE,reports}));
  }finally{capture=null;pg.Client.prototype.query=original;await lab.close();}
 });
});
