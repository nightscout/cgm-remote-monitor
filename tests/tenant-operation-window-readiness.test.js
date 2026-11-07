'use strict';
const assert = require('node:assert/strict');
const {admit} = require('../lib/tenant-lifecycle/operation-window-readiness');
const protocol = require('./fixtures/operation-window-admission-protocol');
const candidate = require('../lib/tenant-lifecycle/postgres-candidate.json');
function client (mutate) { const respond=protocol(mutate); return {query:async (sql,values)=>respond(sql,values)}; }

describe('Operation-window admission (catalog protocol double, not native PostgreSQL)', function () {
  it('admits exact dedicated lifetime and read-only lower profiles, preserving frozen identities', async function () {
    const identity=await admit(client(), 'synthetic_window', {lifetime:true});
    assert.ok(Object.isFrozen(identity));
    assert.equal(identity.windowsOid,42);
    assert.deepEqual(await admit(client(),'synthetic_window',{identity}),identity);
  });
  const controls = [
    ['elevated membership', 'role', r=>{r.elevated_membership=true;}],
    ['unrelated lifetime writes','role',r=>{r.foreign_writes=true;}],
    ['unknown role metadata','role',r=>{delete r.elevated;}],
    ['schema ownership','role',r=>{r.owns_schema=true;}],
    ['schema CREATE','role',r=>{r.schema_writes=true;}],
    ['table ownership','tenant_lifecycle_operations',r=>{r.owns=true;}],
    ['login owner','tenant_lifecycle_operations',r=>{r.owner_safe=false;}],
    ['table-level writes','tenant_lifecycle_operations',r=>{r.broad_writes=true;}],
    ['caller-selected backend PID','tenant_lifecycle_operations',r=>{r.columns.find(c=>c.name==='owner_pid').inserts=true;}],
    ['caller-selected backend birth','tenant_lifecycle_operations',r=>{r.columns.find(c=>c.name==='owner_birth').inserts=true;}],
    ['caller-selected finished flag','tenant_lifecycle_operations',r=>{r.columns.find(c=>c.name==='finished').inserts=true;}],
    ['mutable operation identity','tenant_lifecycle_operations',r=>{r.columns[1].updates=true;}],
    ['lost backend birth default','tenant_lifecycle_operations',r=>{r.columns.at(-1).default='now()';}],
    ['foreign backend update widening','tenant_lifecycle_operations',r=>{r.policies.find(p=>p.command==='w').using="tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";}],
    ['PID-reuse birth omission','tenant_lifecycle_operations',r=>{r.policies.find(p=>p.command==='w').check=r.policies.find(p=>p.command==='w').check.replace(' AND owner_birth = tenant_lifecycle_backend_birth()','');}],
    ['extra permissive policy','tenant_lifecycle_operations',r=>{r.policies.push({...r.policies[0],using:'true'});}],
    ['phase constraint drift','tenant_lifecycle_windows',r=>{r.constraints.pop();}],
    ['trigger effects','tenant_lifecycle_operations',r=>{r.triggers=true;}],
    ['invalid index','tenant_lifecycle_windows',r=>{r.bad_indexes=true;}],
    ['privileged helper','function',r=>{r.prosecdef=true;}],
    ['unfixed helper search path','function',r=>{r.proconfig=null;}],
    ['PUBLIC helper execution','function',r=>{r.public_executes=true;}],
    ['helper body drift','function',r=>{r.prosrc='SELECT now()';}],
    ['ledger drift','ledger',r=>{r.checksum='0'.repeat(64);}]
  ];
  for (const [label,kind,breakIt] of controls) it('ordinary → refuses '+label+' → fresh restoration',async function () {
    await admit(client(),'synthetic_window',{lifetime:true});
    await assert.rejects(admit(client((type,rows)=>{if(type===kind)breakIt(rows[0]);}),'synthetic_window',{lifetime:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    await admit(client(),'synthetic_window',{lifetime:true});
  });
  it('refuses replaced relations even when their schema matches',async function () {
    const identity=await admit(client(),'synthetic_window',{lifetime:true});
    await assert.rejects(admit(client((kind,rows)=>{if(kind==='tenant_lifecycle_windows')rows[0].oid=900;}),'synthetic_window',{identity,lifetime:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
  });
  it('lower clients cannot mutate operations or execute the backend-birth helper',async function () {
    for (const kind of ['tenant_lifecycle_operations','function']) {
      await assert.rejects(admit(client((type,rows)=>{
        if(type!==kind)return;
        if(kind==='function')rows[0].executes=true;
        else rows[0].columns[0].inserts=true;
      }),'synthetic_window'),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    }
  });
  it('appends checksummed owner defaults and both physical-backend checks without grants or clearance SQL',function () {
    const migrations=require('../lib/migrations/catalogue').validateCatalogue(candidate);
    const sql=migrations.at(-1).up.join('\n');
    assert.match(sql,/owner_pid integer NOT NULL DEFAULT pg_backend_pid\(\)/);
    assert.match(sql,/owner_birth timestamp with time zone NOT NULL DEFAULT tenant_lifecycle_backend_birth\(\)/);
    for(const command of ['INSERT','UPDATE']) {
      const policy=migrations.at(-1).up.find(v=>v.includes('FOR '+command));
      assert.match(policy,/owner_pid = pg_backend_pid\(\)/);
      assert.match(policy,/owner_birth = tenant_lifecycle_backend_birth\(\)/);
    }
    assert.equal(migrations.at(-1).up.some(v=>/^(GRANT|DELETE|TRUNCATE|UPDATE) /i.test(v)),false);
  });
});
