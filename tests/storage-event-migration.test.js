'use strict';
const assert=require('node:assert/strict'),catalogue=require('../lib/migrations/catalogue'),builder=require('../lib/storage/storage-event-identity-sql');
describe('reviewed old-identity WAL operation without new history projection',()=>{
 for(const domain of require('../lib/storage/clinical-storage-size-sql').DOMAINS)it('appends '+domain+' identity and preserves catalogue/inventory enforcement',()=>{
  const input=require('../migrations/candidates/postgres-'+domain+'-v1.json'),migration=catalogue.validateCatalogue(input).at(-1);
  assert.deepEqual(migration.operation,{kind:'storage-event-identity-v1',domain});
  assert.deepEqual(catalogue.renderMigration(migration,'synthetic_'+domain),builder.build({namespace:'synthetic_'+domain,domain}));
  assert.deepEqual(catalogue.operationTables(migration),[]);assert(require('../lib/tenant-operations/catalogues').createdTables(input).includes(domain));
  const broken=structuredClone(input),last=broken.migrations.at(-1);last.up=last.up.map(sql=>sql.replace('FULL','DEFAULT'));last.checksum=catalogue.checksum(last.up);
  assert.throws(()=>catalogue.validateCatalogue(broken),error=>error.code==='MIG_OPERATION_SQL');
 });
 it('keeps unknown migration, checksum drift and missing ordinary history refusals with the new exact tail',async()=>{
  const files=catalogue.validateCatalogue(require('../migrations/candidates/postgres-food-v1.json')),inspect=require('../lib/migrations/postgres-check').inspect;
  const run=rows=>inspect(async text=>text.startsWith('SELECT to_regclass')?{rows:[{present:true}]}:{rows},{table:'synthetic.schema_migrations',files});
  const rows=files.map(file=>({name:file.name,checksum:file.checksum}));assert.equal((await run(rows)).current,true);
  for(const bad of [[...rows,{name:'0101_unknown',checksum:'a'.repeat(64)}],rows.map((r,i)=>i===rows.length-1?{...r,checksum:'a'.repeat(64)}:r),rows.slice(1)])await assert.rejects(run(bad),error=>['MIG_UNKNOWN','MIG_DRIFT','MIG_HISTORY'].includes(error.code));
 });
});
