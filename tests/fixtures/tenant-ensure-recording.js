'use strict';
// SQL/driver recording only. This is NOT PostgreSQL/Vault qualification.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const A = '11111111-1111-4111-8111-111111111111', OP = '22222222-2222-4222-8222-222222222222';
const kinds = ['registry','legacy','secrets','authorization','access','clock','control','settings','operatorPolicy'];
const names = kinds.map(k => 'ensure_' + k.toLowerCase());
const ns = Object.fromEntries(kinds.map((k,i) => [k,names[i]]));
const publicOf = purpose => Buffer.alloc(32,['access','management','human-data','human-management'].indexOf(purpose)+1).toString('base64');
const pub = publicOf('human-management');
const keyRows = () => [['access','key1'],['management','management1'],['human-data','human-data-1'],['human-management','human-management-1']].map(([purpose,kid]) => ({purpose,kid,public_key:publicOf(purpose)}));
function load (relative, overrides, mutate) {
  const file = path.resolve(__dirname,'../..',relative), req = require('node:module').createRequire(file), m = {exports:{}};
  let source = fs.readFileSync(file,'utf8');
  if (mutate) { const before = source; source = mutate(source); assert.notEqual(source,before,'control must change actual source'); }
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})',{filename:file})(x => Object.hasOwn(overrides,x) ? overrides[x] : req(x),m,m.exports);
  return m.exports;
}
module.exports = function fixture (options = {}) {
  const log = [], clients = [], vaultCalls = [];
  const data = { registered: options.fresh ? false : true, settings: !options.missingSettings, keys: keyRows(), events: [], history: options.fresh ? [] : [{version:1,values:{SHOW_SECONDS:true}}], protected: {clinical:'unchanged',credentialGeneration:9,revoked:true,checkpoint:123},residues:options.residues || [] };
  let selected = null, sessionOwner = new Map(), serial = 0, constructors = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  class Client extends require('node:events').EventEmitter {
    constructor (purpose) { super(); this.purpose=purpose; this.id = ++serial; this.processID=100+this.id; clients.push(this); }
    async query (text, values = []) {
      log.push({id:this.id,text,values});
      if (options.fail && options.fail(text,values)) throw Object.assign(Error('SYNTHETIC_QUERY_FAILURE'),{code:'57014'});
      if (text.startsWith('SELECT pg_backend_pid() AS pid,')) return {rows:[{pid:options.wrongPid?0:this.processID,database:(options.wrongFreshDatabase || options.changeFreshAfterKey && vaultCalls.some(c=>c.method==='POST'))&&this.purpose==='nightscout-admin-provisioning'?'other':'synthetic',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:options.changedPostmaster?'changed':'1700000000.000000'}]};
      if (text.includes('pg_catalog.pg_control_system()')) return {rows:[{cluster:options.wrongFreshCluster&&this.purpose==='nightscout-admin-provisioning'?'7000000000000000002':'7000000000000000001'}]};
      if (text.includes('pg_try_advisory_lock(')) {
        const key = (text.includes('hashtextextended') ? 'provision:' : 'life:')+values[0];
        const held = !(options.sharedWriter && key.startsWith('life:')) && (!sessionOwner.has(key) || sessionOwner.get(key) === this); if (held) sessionOwner.set(key,this); return {rows:[{held}]};
      }
      if (text.includes('pg_advisory_unlock(')) { const key=(text.includes('hashtextextended')?'provision:':'life:')+values[0];const released = sessionOwner.get(key)===this && !options.unlockFalse;if(released)sessionOwner.delete(key);return{rows:[{released}]}; }
      if (text.startsWith('BEGIN')) { this.snapshot = copy(data); return {command:'BEGIN',rows:[]}; }
      if (text === 'COMMIT') { this.snapshot = null; if (options.commitReplyLost) { options.commitReplyLost = false; throw Error('SYNTHETIC_LOST_COMMIT_REPLY'); } return {command:'COMMIT',rows:[]}; }
      if (text === 'ROLLBACK') { if (this.snapshot) Object.assign(data,this.snapshot); this.snapshot = null; return {command:'ROLLBACK',rows:[]}; }
      if (text.includes('ensure-dependency-role')) return {rows:[{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false}]};
      if (text.includes('ensure-dependency-ledger')) {
        const namespace=/FROM "([^"]+)"/.exec(text)[1];
        const kind=dependency.kinds.find(k=>mapping[k].some(n=>n.namespace===namespace));
        return {rows:dependency.families[kind][0].candidate.migrations.map(m=>({name:m.name,checksum:options.badDependencyLedger?'bad':m.checksum}))};
      }
      if (text.includes('ensure-dependency-unknown')) return {rows:options.unknownStore?[{nspname:'unknown',relname:'unknown'}]:[]};
      if (text.includes('ensure-dependency-relation')) {
        const name=values[0],table=name.split('.')[1],isHost=table==='tenant_registry_hosts';
        const children=['tenant_lifecycle_ceremony','tenant_lifecycle_operations','tenant_lifecycle_restore_audit','tenant_lifecycle_restore_resume','tenant_lifecycle_operation_clearance'];
        return {rows:[{oid:'123',relkind:'r',relpersistence:'p',uuid:true,attnotnull:true,relrowsecurity:!isHost,relforcerowsecurity:!isHost,binds:!options.badDependencyPolicy,owns:false,rolcanlogin:false,rolsuper:false,rolbypassrls:false,indexed:!children.includes(table)&&!(options.missingDependencyIndex&&table==='tenant_subject_admin_audit')}]};
      }
      if (text.includes('ensure-dependency-fk')) {const ceremony=values[0].endsWith('.tenant_lifecycle_ceremony');return{rows:options.missingDependencyIndex&&values[0].endsWith('.tenant_subject_admin_audit')?[]:[{convalidated:!options.invalidFk,child_not_null:true,parent_namespace:ns.control,parent_table:ceremony?'tenant_lifecycle_requests':'tenant_lifecycle_windows',child_columns:ceremony?['request_id','tenant_id']:['tenant_id'],parent_columns:ceremony?['request_id','tenant_id']:['tenant_id']}]};}
      if (text.includes('ensure-dependency-residue')) {
        const match=/FROM "([^"]+)"\."([^"]+)"/.exec(text),table=match[2],relation=match[1]+'.'+table;
        const present=table==='tenant_settings_history'?data.history.length>0:table==='tenant_ensure_events'?data.events.some(e=>e.registered===true):!!options.residue || data.residues.includes(relation);
        return {rows:[{present}]};
      }
      if (text.includes('tenant-phase-key')) return {rows:[{lock_key:require('../../lib/tenant-registry/rules').lockKey(A)}]};
      if (text.includes('tenant-phase-hold')) return {rows:[{held:!options.lifecycleHeld}]};
      if (text.includes('tenant-phase */')) return {rows:[{lock_key:require('../../lib/tenant-registry/rules').lockKey(A),phase:options.suspended ? 'suspended' : 'active',deletion:!!options.deletion}]};
      if (text.startsWith('SELECT lock_key::text AS key')) return {rows:[{key:require('../../lib/tenant-registry/rules').lockKey(A)}]};
      if (text.includes(' AS pending')) return {rows:[{pending:!!options.pending}]};
      if (text.includes('SELECT state FROM')) return {rows:data.registered ? [{state:options.removed ? 'removed' : 'active'}] : []};
      if (text.includes('SELECT host, kind')) return {rows:data.registered ? [{host:'one.example.test',kind:'alias'}] : []};
      if (text.startsWith('SELECT host FROM')) return {rows:[]};
      if (text.includes(' AS retained_residue')) return {rows:[{retained_residue:data.history.length>0 || !!options.residue}]};
      if (text.includes(' AS a0,')) {
        const row = {}; for (let i=0;i<13;i++) { row['a'+i] = data.registered; row['k'+i] = data.registered; }
        row.a0 = data.keys.length > 0 && data.registered; row.k0 = data.registered && data.keys.length === 4;
        // Follow the emitted structural SELECT: adding a protected record must
        // not silently turn the missing-settings scenario into another defect.
        const record = (namespace, table, present) => {
          const expression = 'FROM "' + namespace + '"."' + table + '" WHERE tenant_id=$1) AS a';
          const at = text.indexOf(expression);
          assert(at >= 0, 'recording fixture requires the actual ' + table + ' predicate');
          const index = /^(\d+),/.exec(text.slice(at + expression.length))?.[1];
          assert(index !== undefined, 'recording fixture requires the structural record alias');
          row['a' + index] = row['k' + index] = data.registered && present;
        };
        record(ns.settings, 'tenant_settings', data.settings);
        record(ns.control, 'tenant_activity', !options.missingActivity);
        record(ns.legacy, 'legacy_data_keys', !options.missingLocalDataKey);
        if (options.otherMissing) row.k3 = false;
        return {rows:[row]};
      }
      if (text.includes(' AS unresolved')) return {rows:[{unresolved:data.events.some(r=>r.phase==='requested' && r.operation_id!==values[1] && !data.events.some(d=>d.operation_id===r.operation_id && d.phase==='result'))}]};
      if (text.startsWith('SELECT phase,request_digest,')) return {rows:data.events.filter(r => r.operation_id === values[1])};
      if (text.includes(' AS observations FROM ')) return {rows:data.events.filter(r => r.result && ['created','complete','repaired'].includes(r.result.outcome)).reverse().slice(0,1).map(r => ({observations:r.observations}))};
      if (text.startsWith('SELECT purpose,kid,public_key')) return {rows:copy(data.keys)};
      if (text.startsWith('SELECT count(*)::integer')) return {rows:[{count:data.history.length,first:data.history[0]?.version || null,version:data.history.at(-1)?.version || null,bytes:String(Buffer.byteLength(JSON.stringify(data.history)))}]};
      if (text.startsWith('SELECT version,CASE')) return {rows:copy(data.history.filter(r=>r.version===values[1]))};
      if (text.startsWith('INSERT INTO "ensure_ledger".tenant_ensure_events')) {
        if (data.events.some(r => r.operation_id === values[1] && r.phase === values[2])) throw Object.assign(Error('duplicate'),{code:'23505'});
        data.events.push({operation_id:values[1],phase:values[2],request_digest:values[3],result:values[6] ? JSON.parse(values[6]) : null,observations:values[7] ? JSON.parse(values[7]) : null,registered:values[8]});return {rows:[],rowCount:1};
      }
      if (text.startsWith('INSERT INTO "ensure_registry"."tenant_registry"')) { assert.equal(sessionOwner.get('life:'+require('../../lib/tenant-registry/rules').lockKey(A)),this,'fresh write requires held lifecycle fence');data.registered = true; return {rows:[]}; }
      if (text.startsWith('INSERT INTO "ensure_registry"."tenant_registry_keys"')) {
        if (values.length === 4 && ['access','management','human-data','human-management'].includes(values[1])) data.keys.push({purpose:values[1],kid:values[2],public_key:values[3]});
        else data.keys = keyRows(); return {rows:[],rowCount:1};
      }
      if (text.startsWith('INSERT INTO "ensure_settings"."tenant_settings"')) { data.settings = true; data.recovered = {version:values[1] || 1,values:values[2] ? JSON.parse(values[2]) : {}}; return {rows:[],rowCount:1}; }
      if (/^(UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/.test(text)) throw Error('UNEXPECTED_MUTATION');
      return {rows:[],rowCount:1};
    }
    release (error) { this.released = error || null; log.push({id:this.id,release:!!error}); if (error) { for (const [key,owner] of sessionOwner) if (owner === this) sessionOwner.delete(key); if (this.snapshot) Object.assign(data,this.snapshot); } }
  }
  class Pool {
    constructor (opts) { constructors++; this.options = opts; }
    on () {}
    connect (callback) { const client = new Client(this.options.application_name); log.push({checkout:client.id}); if (callback) { callback(null,client); return; } return Promise.resolve(client); }
    async end () {}
  }
  const availableKeys = new Set(options.fresh ? [] : Object.keys(require('../../lib/tenant-registry/rules').PURPOSES));
  const fetchImpl = async (url,init = {}) => {
    const method = init.method || 'GET'; vaultCalls.push({method,url});
    if (options.vaultBarrier) await options.vaultBarrier;
    if (options.vaultMissing && url.includes('tenant-'+options.vaultMissing+'-')) return {status:404,ok:false,body:{cancel:async()=>{}}};
    const purpose = Object.keys(require('../../lib/tenant-registry/rules').PURPOSES).find(p=>url.includes('tenant-'+p+'-'));
    const type = ['data','signing'].includes(purpose) ? 'aes256-gcm96' : 'ed25519';
    if (method === 'POST') availableKeys.add(purpose);
    if (method === 'GET' && !availableKeys.has(purpose)) return {status:404,ok:false,body:{cancel:async()=>{}}};
    const bytes = Buffer.from(JSON.stringify({data:{type:options.wrongType ? 'wrong' : type,exportable:false,keys:{'1':{public_key:options.publicOverride?.[purpose] || publicOf(purpose)}}}}));
    return {status:200,ok:true,body:(async function * () { yield bytes; })()};
  };
  const common = { ...(options.vaultKeys ? {'./vault-keys':options.vaultKeys} : {}), 'pg':{Pool,Client},'../storage/connection-admission':{health:()=>selected,wrapPool:()=>Pool,poolOptions:(_name,v)=>v}};
  const provision = load('lib/tenant-registry/provision.js',{...common,'../diagnostics/m7':{observePool:()=>{}},'../secrets/vault-transit':{createVaultTransit:()=>({encrypt:async()=> 'vault:v1:synthetic'})}},options.mutateProvision);
  const ensure = load('lib/tenant-registry/ensure.js',{...common,'./provision':provision,'./ensure-readiness':Object.assign(async()=>{},{admit:async()=>{}})},options.mutateEnsure);
  const config = {connectionString:'postgres://synthetic:synthetic@localhost/synthetic',namespaces:ns,ledgerNamespace:'ensure_ledger',checkpoints:[],actor:{principal:'operator',consumer:'ensure'},vault:{address:'http://127.0.0.1/',mount:'transit',getToken:async()=> 'synthetic',allowInsecureLoopback:true,fetchImpl},fetchImpl};
  const dependency=require('../../lib/tenant-registry/ensure-dependencies');
  const aliases={control:'lifecycle',settings:'tenant_settings',operatorPolicy:'operator_policy'};
  const mapping=Object.fromEntries(dependency.kinds.map(kind=>[kind,[]]));
  for (const [kind,namespace] of Object.entries(ns)) mapping[aliases[kind] || kind]=[{namespace,catalogue:'canonical'}];
  mapping.ensure_ledger=[{namespace:'ensure_ledger',catalogue:'canonical'}];
  if (options.addFamilies) for (const [kind,instances] of Object.entries(options.addFamilies)) mapping[kind]=instances;
  if (options.dependencies!==false) config.dependencyNamespaces=mapping;
  config.requireCompleteDependencies=options.requireCompleteDependencies!==false;
  const input = {operationId:OP,id:A,hosts:['one.example.test']};
  return {A,OP,ns,pub,data,log,clients,vaultCalls,config,input,ensure,provision,
    set selected(value) { selected = value; }, get constructors () { return constructors; }, load,
    create: () => ensure.createEnsure(config), fresh: () => provision.createProvisioning(config)};
};
