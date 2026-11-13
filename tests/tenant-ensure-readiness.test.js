'use strict';
// covers: lib/tenant-registry/ensure-readiness.js, lib/tenant-registry/ensure.js, lib/tenant-registry/ensure-candidate.json
const assert=require('node:assert/strict');
const ready=require('../lib/tenant-registry/ensure-readiness');
const {grants}=require('../lib/tenant-registry/ensure');
const fixture=require('./fixtures/tenant-ensure-recording');
const ns=fixture().ns;
const schema=require('../lib/tenant-settings/postgres-candidate.json');
const ledger=require('../lib/tenant-registry/ensure-candidate.json');
const validator=/AS \$\$([\s\S]*)\$\$$/.exec(schema.migrations.flatMap(m=>m.up).find(s=>s.startsWith('CREATE FUNCTION tenant_settings_values_valid(')))[1];
function client(options={}){
 const log=[];
 return {log,async query(text){log.push(text);
  if(text.startsWith('SELECT rolsuper'))return{rows:[{rolsuper:!!options.superuser,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false}]};
  if(text.includes(' AS extra_reads'))return{rows:[{extra_reads:!!options.extraReads}]};
  if(text.includes(' AS creates'))return{rows:[{creates:false,mutates:!!options.unrelatedWrite}]};
  if(text.includes(' AS history_rewrite'))return{rows:[['ensure_ledger','tenant_ensure_events'],[ns.settings,'tenant_settings'],[ns.registry,'tenant_registry_keys'],[ns.settings,'tenant_settings_history']].map(([namespace,name])=>({namespace,name,relrowsecurity:!options.noRls,relforcerowsecurity:true,rolcanlogin:false,rolsuper:false,rolbypassrls:false,owns:false,rewrites:false,binds:!options.widePolicy,history_rewrite:!!options.mutableHistory}))};
  if(text.includes(' AS ciphertext'))return{rows:[{sequence_updates:!!options.sequenceRewrite,sequence_owned:false,identity_insert:!!options.identityOverride,time_insert:false,ciphertext:!!options.ciphertext,definer:!!options.definer}]};
  if(text.includes('FROM pg_trigger'))return{rows:[{namespace:ns.registry,relation:'tenant_registry_keys',tgname:'tenant_registry_keys_revision',tgtype:60,tgenabled:'O',prosrc:require('../lib/tenant-registry/postgres').TOUCH+(options.badTrigger?' changed':''),prosecdef:true,proconfig:['search_path="'+ns.registry+'", pg_catalog'],lanname:'plpgsql',same_owner:true,rolcanlogin:false,rolsuper:false,rolbypassrls:false}]};
  if(text.includes('WHERE p.oid=to_regprocedure'))return{rows:[{executable:!options.noValidatorExecute,prosrc:validator+(options.badValidator?' changed':''),prosecdef:false,proisstrict:true,provolatile:'i',proconfig:null,lanname:'sql',result:'boolean',rolcanlogin:false,rolsuper:false,rolbypassrls:false}]};
  if(text.includes('.schema_migrations ORDER BY name'))return{rows:(text.includes('ensure_ledger')?ledger:schema).migrations.map(m=>({name:m.name,checksum:options.badMigration?'bad':m.checksum}))};
  return{rows:[],command:text==='ROLLBACK'?'ROLLBACK':undefined};
 }};
}
describe('ensure-specific current catalogue and least-privilege source admission',function(){
 it('admits fixed canonical append-only proof and runs no mutation',async function(){
  const c=client();await ready({client:c,namespaces:ns,ledgerNamespace:'ensure_ledger',checkpoints:[]});
  assert.equal(c.log[0],'BEGIN READ ONLY');assert.equal(c.log.at(-1),'ROLLBACK');assert(!c.log.some(s=>/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/.test(s)));
 });
 for(const flag of ['superuser','unrelatedWrite','noRls','widePolicy','mutableHistory','ciphertext','definer','badTrigger','badValidator','badMigration','sequenceRewrite','extraReads','identityOverride','noValidatorExecute'])it('refuses '+flag+' without relaxing application readiness',async function(){
  const c=client({[flag]:true});await assert.rejects(ready({client:c,namespaces:ns,ledgerNamespace:'ensure_ledger',checkpoints:[]}));
 });
 it('rechecks within the already owned repair transaction without nested BEGIN/COMMIT',async function(){
  const c=client();await ready.admit({client:c,namespaces:ns,ledgerNamespace:'ensure_ledger',checkpoints:[]});
  assert(!c.log.some(s=>/^(BEGIN|COMMIT|ROLLBACK)/.test(s)));
 });
 it('generates only explicit proof SELECT and narrow reconstruction/audit INSERT capabilities',function(){
  const sql=grants({namespaces:ns,ledgerNamespace:'ensure_ledger',role:'ensure_operator'});
  assert(sql.some(s=>s.includes('INSERT (tenant_id,version,values)')));assert(sql.some(s=>s.includes('INSERT (tenant_id,purpose,kid,public_key)')));
  assert(sql.every(s=>!(/\b(UPDATE|DELETE|TRUNCATE|CREATE|ALTER|ALL)\b/.test(s))));
  assert(!sql.some(s=>s.includes('ciphertext')));
  for (const statement of sql.filter(s=>s.includes('access_sessions')||s.includes('secret_audit'))) assert.match(statement,/^GRANT SELECT \(tenant_id\) ON /);
  assert.throws(()=>grants({namespaces:ns,ledgerNamespace:'ensure_ledger',role:'bad-role'}));
 });
});
