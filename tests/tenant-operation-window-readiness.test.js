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
  it('admits the separate private maintenance profile with append-only resume/clearance grants and without authority mutation', async function () {
    const identity=await admit(client(),'synthetic_window',{maintenance:true});
    assert(identity.authorityOid && identity.auditOid && identity.resumeOid && identity.clearanceOid);
    for (const [kind,column,field] of [
      ['tenant_lifecycle_restore_authority','active','updates'],
      ['tenant_lifecycle_restore_audit','owner_pid','inserts'],
      ['tenant_lifecycle_restore_audit','artifact_digest','updates'],
      ['tenant_lifecycle_windows','lock_key','updates'],
      ['tenant_lifecycle_operations','finished','updates']
    ]) await assert.rejects(admit(client((type,rows)=>{if(type===kind)rows[0].columns.find(c=>c.name===column)[field]=true;}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    await assert.rejects(admit(client(),'synthetic_window',{maintenance:true,lifetime:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
  });
  for (const table of ['tenant_lifecycle_restore_resume','tenant_lifecycle_operation_clearance']) {
    for (const mode of [{},{lifetime:true},{maintenance:true}]) it('admits exact '+table+' then refuses catalogue drift in '+JSON.stringify(mode),async function () {
      const mutate = change => client((kind,rows)=>{if(kind===table)change(rows[0]);});
      const changes = [
        row=>{row.secured=false;},row=>{row.owns=true;},row=>{row.owner_safe=false;},row=>{row.owner_oid=999;},
        row=>{row.broad_writes=true;},row=>{row.reads=!row.reads;},row=>{row.columns[0].type='text';},
        row=>{row.columns.find(c=>c.name==='owner_pid').inserts=true;},row=>{row.columns.find(c=>c.name==='owner_birth').default='now()';},
        row=>{row.columns[0].updates=true;},row=>{row.constraints.pop();},row=>{row.constraints[0].valid=false;},
        row=>{row.policies[0].using='true';},row=>{row.policies.find(p=>p.command==='a').check='true';},
        row=>{row.policies[0].roles=[42];},row=>{row.policies.push({...row.policies[0]});},row=>{row.triggers=true;}
      ];
      if (!mode.maintenance) changes.push(row=>{row.columns[0].inserts=true;});
      else changes.push(row=>{row.columns[0].inserts=false;});
      for (const change of changes) {
        await admit(client(),'synthetic_window',mode);
        await assert.rejects(admit(mutate(change),'synthetic_window',mode),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      }
      const identity=await admit(client(),'synthetic_window',mode);
      await assert.rejects(admit(mutate(row=>{row.oid=999;}),'synthetic_window',{...mode,identity}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      assert.deepEqual(await admit(client(),'synthetic_window',mode),identity);
    });
  }
  it('covers both new relations in lower and lifetime epoch names and every per-relation catalogue input',async function () {
    const epoch=require('../lib/tenant-lifecycle/operation-window-epoch');
    const identity=await admit(client(),'synthetic_window',{lifetime:true});
    for (const lifetime of [false,true]) {
      const sql=epoch.sql('synthetic_window',lifetime,identity);
      for (const name of ['tenant_lifecycle_restore_resume','tenant_lifecycle_operation_clearance']) assert(sql.includes('to_regclass(\'"synthetic_window".'+name+'\')'));
      const ids="'{41,42,43,44,45,46,47}'::oid[]";
      for (const [relation,column] of [['pg_attribute','attrelid'],['pg_attrdef','adrelid'],['pg_constraint','conrelid'],['pg_policy','polrelid'],['pg_trigger','tgrelid'],['pg_rewrite','ev_class'],['pg_index','indrelid'],['pg_inherits','inhrelid']]) {
        assert(sql.includes('FROM '+relation+' x WHERE '));assert(sql.includes('x.'+column+' = ANY('+ids+')'),relation+' covers both audit tables');
      }
      for (const key of ['resumeOid','clearanceOid']) {
        const missing={...identity};delete missing[key];
        assert.throws(()=>epoch.sql('synthetic_window',lifetime,missing),/Admitted catalogue identity required/);
      }
    }
  });
  it('operator grants insert only approved record columns and never audit mutation or owner selection',function () {
    const grants=require('../lib/tenant-lifecycle/maintenance-window').operatorGrants({namespace:'synthetic_window',role:'synthetic_operator'});
    for (const [table,columns] of [['tenant_lifecycle_restore_resume','tenant_id,resume_id,claim_id,generation,artifact_digest,interrupted'],['tenant_lifecycle_operation_clearance','tenant_id,operation_id,generation,marker_pid,marker_birth']]) {
      assert(grants.includes('GRANT INSERT ('+columns+') ON "synthetic_window"."'+table+'" TO "synthetic_operator"'));
      assert(!grants.some(sql=>sql.includes('"'+table+'"') && /UPDATE|DELETE|TRUNCATE/.test(sql)));
    }
  });
  it('structural policy comparison retains correlated AND/OR grouping and literal semantics',async function () {
    const {canonical,policiesFor}=require('../lib/tenant-lifecycle/operation-window-readiness');
    const expected=policiesFor('tenant_lifecycle_restore_resume').find(p=>p.command==='a').check;
    const grouped=expected.replace("AND ((r.state = 'suspended'", "AND (r.state = 'suspended'").replace("'data-replaced')))","'data-replaced'))");
    assert.notEqual(canonical(expected,'synthetic_window'),canonical(grouped,'synthetic_window'));
    for (const changed of [grouped,expected.replace("'before-data'","'BEFORE-DATA'"),expected.replace("'before-data'","'before- data'"),expected.replace('r.claim_id','r."Claim_id"'),expected.replace(' AND a.active',' OR a.active')]) {
      await assert.rejects(admit(client((kind,rows)=>{if(kind==='tenant_lifecycle_restore_resume')rows[0].policies.find(p=>p.command==='a').check=changed;}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    }
    assert.equal(canonical("'Case  preserved'::text"),canonical("'Case  preserved'"));
    assert.notEqual(canonical('"TRUE"'),canonical('true'));
    assert.notEqual(canonical('"current_user"'),canonical('CURRENT_USER'));
    for (const name of ['pg_backend_pid','current_setting','text','pg_stat_activity']) {
      const builtin=name==='text' ? "'value'::pg_catalog.text" : name==='pg_stat_activity' ? 'SELECT backend_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()' : name==='current_setting' ? "pg_catalog.current_setting('key',true)" : 'pg_catalog.pg_backend_pid()';
      const shadow=builtin.replace('pg_catalog.','synthetic_window.');
      let changed;try {changed=canonical(shadow,'synthetic_window');} catch(error) {assert.equal(error.code,'LIFECYCLE_WINDOW_SCHEMA_UNSAFE');continue;}
      assert.notEqual(changed,canonical(builtin,'synthetic_window'),'SHADOW_QUALIFICATION_'+name);
    }
    assert.equal(canonical('( ( tenant_id ) )'),canonical('tenant_id'));
    assert.notEqual(canonical("'One Two'"),canonical("'one two'"));
    assert.notEqual(canonical("'one two'"),canonical("'onetwo'"));
    assert.equal(canonical("'it''s'"),JSON.stringify(['string',"it's"]));
    for (const value of ['not','exists','array','true','and','or']) assert.equal(canonical("'"+value+"'"),JSON.stringify(['string',value]));
    await admit(client(),'synthetic_window',{maintenance:true});
  });
  it('distinguishes absent metadata from empty/malformed/unsupported SQL and refuses bounded grammar escapes',async function () {
    const {canonical}=require('../lib/tenant-lifecycle/operation-window-readiness');
    assert.equal(canonical(null),JSON.stringify(['absent']));
    assert.throws(()=>canonical(undefined),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    for (const value of ['', ' ', 1, {}, "'unterminated", 'tenant_id)', '(tenant_id', "E'escape'", '$x$quoted$x$', 'tenant_id -- comment', 'tenant_id /* comment */', 'tenant_id COLLATE "C"', 'now() + 1', 'other_function()', 'tenant_id::integer', 'a=b=c', 'EXISTS(SELECT 1 FROM anything WHERE true UNION SELECT 1)', '('.repeat(100)+'true'+')'.repeat(100)]) {
      assert.throws(()=>canonical(value,'synthetic_window'),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      await assert.rejects(admit(client((kind,rows)=>{if(kind==='tenant_lifecycle_restore_resume')rows[0].policies[0].check=value;}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    }
    for (const kind of ['tenant_lifecycle_restore_resume','tenant_lifecycle_operation_clearance']) {
      for (const field of ['using','check']) for (const value of [undefined,'',' ',"'broken"]) {
        await assert.rejects(admit(client((type,rows)=>{if(type===kind)rows[0].policies[0][field]=value;}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
        await assert.rejects(admit(client((type,rows)=>{if(type===kind)delete rows[0].policies[0][field];}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      }
      await assert.rejects(admit(client((type,rows)=>{if(type===kind)delete rows[0].columns[0].default;}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    }
    // An absent USING/CHECK is legal only where the expected node is absent.
    await assert.rejects(admit(client((kind,rows)=>{if(kind==='tenant_lifecycle_restore_resume')rows[0].policies[0].using=null;}),'synthetic_window',{maintenance:true}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    await admit(client(),'synthetic_window',{maintenance:true});
  });
  const controls = [
    ['elevated membership', 'role', r=>{r.elevated_membership=true;}],
    ['non-system executable function bypass','role',r=>{r.foreign_functions=true;}],
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
    const physical=migrations.find(row=>row.name==='0003_tenant_lifecycle_operation_windows');
    const sql=physical.up.join('\n');
    assert.match(sql,/owner_pid integer NOT NULL DEFAULT pg_backend_pid\(\)/);
    assert.match(sql,/owner_birth timestamp with time zone NOT NULL DEFAULT tenant_lifecycle_backend_birth\(\)/);
    for(const command of ['INSERT','UPDATE']) {
      const policy=physical.up.find(v=>v.includes('FOR '+command));
      assert.match(policy,/owner_pid = pg_backend_pid\(\)/);
      assert.match(policy,/owner_birth = tenant_lifecycle_backend_birth\(\)/);
    }
    assert.equal(physical.up.some(v=>/^(GRANT|DELETE|TRUNCATE|UPDATE) /i.test(v)),false);
  });
});
