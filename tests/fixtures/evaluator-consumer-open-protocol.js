'use strict';
// Executes the ACTUAL inherited fixture .open/.reset/.close code. Only PG driver,
// connection and migration effects are replaced by a bounded setup-order protocol;
// this proves no RLS, SQL delivery or native database acceptance.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm');
module.exports=function openProtocol({env,...options}={}) {
  if(!env||typeof env!=='object'||Array.isArray(env)||typeof env.NS_TEST_POSTGRES_ADMIN_URI!=='string') {
    throw new TypeError('Explicit synthetic fixture environment required');
  }
  const processFacade=Object.freeze({env:Object.freeze({...env}),execPath:process.execPath,kill(pid,signal){calls.push({kind:'kill-owned-group',pid,signal});}});
  const calls=[],schemas=new Set(),roles=new Set(),clients=[],cache=new Map();
  let creations=0, interrupt=false;
  function beforeEffect(){if(interrupt){interrupt=false;throw refusal('SYNTHETIC_AFTER_CREATION_REFUSED');}}
  function created(){creations++;if(options.interruptAfterCreate===creations)interrupt=true;}
  const fixtures=__dirname,app=path.resolve(fixtures,'../..');
  function refusal(code){return Object.assign(new Error(code),{code});}
  function query(text,values,role) {
    beforeEffect();
    if(text.includes('SELECT version()'))return {rows:[{version:'synthetic-open-protocol'}]};
    if(text.includes('SELECT current_user AS role'))return {rows:[{role}]};
    const schema=text.match(/^CREATE SCHEMA "([^"]+)"/);
    if(schema){if(schemas.has(schema[1]))throw refusal('42P06');schemas.add(schema[1]);created();calls.push({kind:'create-schema',namespace:schema[1]});return {rows:[]};}
    const create=text.match(/^CREATE ROLE "([^"]+)"/);
    if(create){if(roles.has(create[1]))throw refusal('42710');calls.push({kind:'create-role',name:create[1]});if(options.failRoleSuffix&&create[1].endsWith(options.failRoleSuffix) || options.failConsumerRoleSuffix&&create[1].startsWith('consumer_join_')&&create[1].endsWith(options.failConsumerRoleSuffix))throw refusal('SYNTHETIC_CREATE_ROLE_REFUSED');roles.add(create[1]);created();return {rows:[]};}
    if(text.startsWith('TRUNCATE')) {
      const found=[...text.matchAll(/"([^"]+)"\./g)].map(row=>row[1]);calls.push({kind:'truncate',schemas:found});
      for(const schema of found)if(!schemas.has(schema))throw refusal('3F000');
    }
    if(text.startsWith('DROP OWNED BY')){const name=text.match(/"([^"]+)"/)[1];calls.push({kind:'drop-owned',name});if(!roles.has(name))throw refusal('42704');}
    if(text.startsWith('DROP ROLE')){const name=text.match(/"([^"]+)"/)[1];calls.push({kind:'drop-role',name});roles.delete(name);}
    if(text.startsWith('DROP SCHEMA')){const name=text.match(/"([^"]+)"/)[1];calls.push({kind:'drop-schema',name});schemas.delete(name);}
    if(text.includes('FROM pg_namespace'))return {rows:schemas.has(values[0])?[{exists:true}]:[]};
    if(/^UPDATE "/.test(text))return {rows:[],rowCount:2};
    return {rows:[],rowCount:0};
  }
  class Client {
    constructor(input){this.role=new URL(input.connectionString).username;clients.push(this);}
    async connect(){this.connected=true;}
    async query(text,values){return query(text,values,this.role);}
    async end(){this.closed=true;}
  }
  const connection=async input=>{
    const client=new Client(input);await client.connect();
    return {query:(text,values)=>client.query(text,values),transaction:fn=>fn(),snapshotTransaction:fn=>fn(),
      withTenant:(tenant,fn)=>require('../../lib/storage/tenant-scope').withTenant(tenant,fn),end:()=>client.end()};
  };
  function load(file) {
    if(cache.has(file))return cache.get(file).exports;
    const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));cache.set(file,m);
    const actual=Module.createRequire(file);
    m.require=id=>{
      if(id==='pg')return {Client};
      if(id==='node:fs'&&options.procStat)return {...fs,readFileSync(file,...args){if(file==='/proc/424242/stat')return options.procStat;return fs.readFileSync(file,...args);}};
      if(id==='process'||id==='node:process')return processFacade;
      if(id==='./pgstream-native')return {
        capability:()=>({binary:'/synthetic/pgstream',receiverPort:19421,subscriptionsPort:19422}),
        configuration:({prefix,capability})=>({receiver:{url:'http://127.0.0.1:'+capability.receiverPort+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:8388608,timeoutMs:5000},slot:prefix+'_stream',streamRole:prefix+'_stream',bounds:{heartbeatMs:1000,stallMs:5000,stepMs:5000,recoveryMs:30000,pendingMs:30000}}),
        async setup(){throw Error('NATIVE_PRODUCER_MUST_NOT_START_IN_SETUP_ORDER_PROTOCOL');}
      };
      const resolved=actual.resolve(id);
      if(resolved===path.join(fixtures,'provisioned-tenants.js'))return {async create(input){
        const owned=[],all={...input.namespaces},ids=new Set();
        try {
          for(const kind of ['registry','legacy','secrets','authorization','access','control','settings','operatorPolicy']){
            const namespace='protocol_'+kind.toLowerCase();await input.admin.query('CREATE SCHEMA "'+namespace+'"');owned.push(namespace);all[kind]=namespace;
          }
          return {namespaces:all,registryGrants:()=>[],async provision({id}){ids.add(id);},provisioning:{async get(id){return ids.has(id)?{state:'active'}:null;}},async close(){for(const namespace of owned.reverse())await input.admin.query('DROP SCHEMA "'+namespace+'" CASCADE');}};
        } catch(error){for(const namespace of owned.reverse())await input.admin.query('DROP SCHEMA "'+namespace+'" CASCADE');throw error;}
      }};
      if(resolved===path.join(app,'lib/server/internal-api/transport.js')&&options.ipc)return options.ipc;
      if(resolved===path.join(app,'lib/storage/postgres-connection.js'))return connection;
      if(resolved===path.join(app,'lib/migrations/postgres.js'))return {async run(action,input){beforeEffect();calls.push({kind:'migration',namespace:input.namespace});schemas.add(input.namespace);return [];}};
      if(resolved.startsWith(fixtures+path.sep)&&resolved.endsWith('.js'))return load(resolved);
      return actual(id);
    };
    // Keep the original source as the function body so its 'use strict'
    // directive and CommonJS exports/require/module semantics remain intact.
    // A lexical process parameter consumes only this protocol's owned env.
    const compiled=vm.compileFunction(fs.readFileSync(file,'utf8'),['exports','require','module','__filename','__dirname','process'],{filename:file});
    const localRequire=Object.assign(id=>m.require(id),actual);
    compiled.call(m.exports,m.exports,localRequire,m,file,path.dirname(file),processFacade);
    return m.exports;
  }
  return {factory:load(path.join(fixtures,'evaluator-consumers-native.js')),calls,schemas,roles,clients};
};
