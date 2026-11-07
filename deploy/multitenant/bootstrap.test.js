'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config'),bootstrap=require('./bootstrap');
function generated(){
  const layout=plan.layout(),urls=Object.fromEntries(Object.keys(layout.roles).map(kind=>[kind,'postgres://'+layout.roles[kind]+':synthetic-only@postgres:5432/nightscout_compose_test']));
  const keys=()=>[plan.A,plan.B].map(tenant=>({tenant,kid:'key1',publicKey:Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url').toString('base64')}));
  return {layout,docs:plan.documents({layout,urls,tokens:['synthetic-a','synthetic-b'],publicKeys:keys(),managementKeys:keys(),vaultAddress:'https://vault:8200'})};
}
function files(docs){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-compose-config-'));
  for(const role of plan.serviceRoles){
    const own=path.join(directory,role);fs.mkdirSync(own,{mode:0o700});
    for(const [name,value]of Object.entries({'config.json':docs.configs[role],'operation.json':docs.operations[role],'admission.json':docs.admission,'evaluator-metadata.json':docs.configs.evaluator}))fs.writeFileSync(path.join(own,name),JSON.stringify(value));
  }
  return directory;
}
test('all generated service configs pass actual product parsers and exact namespace manifests',()=>{
  const {docs}=generated(),directory=files(docs);try{plan.validateFiles(directory,docs);}finally{fs.rmSync(directory,{recursive:true});}
});
test('control: absent notification namespace refuses actual API cohort match, restoration passes',()=>{
  const {docs}=generated();docs.operations.api.participants.find(row=>row.id==='api').namespaces=docs.operations.api.participants.find(row=>row.id==='api').namespaces.filter(name=>!name.endsWith('_outbox'));
  let directory=files(docs);try{assert.throws(()=>plan.validateFiles(directory,docs),/namespace mismatch/);}finally{fs.rmSync(directory,{recursive:true});}
  const restored=generated();directory=files(restored.docs);try{plan.validateFiles(directory,restored.docs);}finally{fs.rmSync(directory,{recursive:true});}
});
test('runtime bundles retain isolated credential capabilities',()=>{
  const {docs}=generated();
  assert(!Object.hasOwn(docs.environments.api,'NS_OUTBOX_PG'));
  assert(!Object.hasOwn(docs.environments.api,'NS_SUPPRESSION_PG'));
  assert(!Object.hasOwn(docs.environments.realtime,'NS_API_PG'));
  assert(!Object.keys(docs.environments.evaluator).some(key=>key.startsWith('NS_VAULT_')));
  assert.equal(new Set(plan.serviceRoles.map(role=>docs.environments[role].NS_LIFETIME_PG)).size,4);
  assert(!JSON.stringify(docs.ui).includes(plan.A));assert(!JSON.stringify(docs.ui).includes('postgres'));
});
test('bootstrap requires explicit intent, dedicated database and HTTPS Vault',()=>{
  const env={NS_COMPOSE_BOOTSTRAP:'1',NS_BOOTSTRAP_OUTPUT:'/tmp/state',NS_SOURCE_COMMIT:'a'.repeat(40),NS_BOOTSTRAP_POSTGRES_URL:'postgres://postgres:synthetic-only@postgres:5432/nightscout_compose_test',VAULT_ADDR:'https://vault:8200'};
  assert.equal(bootstrap.input(env).pg.hostname,'postgres');
  assert.throws(()=>bootstrap.input({...env,NS_COMPOSE_BOOTSTRAP:'0'}),/EXPLICIT_COMPOSE/);
  assert.throws(()=>bootstrap.input({...env,NS_BOOTSTRAP_POSTGRES_URL:'postgres://postgres:synthetic-only@postgres:5432/real_database'}),/DEDICATED/);
  assert.throws(()=>bootstrap.input({...env,VAULT_ADDR:'http://vault:8200'}),/HTTPS/);
});
test('private output refuses overwrite and never inherits readable permissions',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-compose-output-')),file=path.join(directory,'secret.json');
  try{bootstrap.writePrivate(file,{synthetic:'secret'});assert.equal(fs.statSync(file).mode&0o777,0o600);assert.throws(()=>bootstrap.writePrivate(file,{changed:true}),/EEXIST/);}finally{fs.rmSync(directory,{recursive:true});}
});
