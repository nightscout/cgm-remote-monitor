'use strict';
const assert=require('node:assert/strict');
const builder=require('../lib/storage/clinical-storage-size-sql'),catalogue=require('../lib/migrations/catalogue');
describe('typed clinical stored-byte projection migration',()=>{
 for(const domain of builder.DOMAINS)it('appends the exact '+domain+' projection and preserves strict rendering',()=>{
  const source=require('../migrations/candidates/postgres-'+domain+'-v1.json'),migration=catalogue.validateCatalogue(source).find(m=>m.operation?.kind==='clinical-storage-size-v1');
  assert.deepEqual(migration.operation,{kind:'clinical-storage-size-v1',domain});
  assert.deepEqual(catalogue.renderMigration(migration,'synthetic_'+domain),builder.build({namespace:'synthetic_'+domain,domain}));
  assert.deepEqual(catalogue.operationTables(migration),[],'NO_NEW_TABLE_INVENTORY');
  assert(require('../lib/tenant-operations/catalogues').createdTables(source).includes(domain));
  const sql=builder.build({namespace:'synthetic_'+domain,domain}).join('\n');
  assert(sql.includes('AFTER INSERT OR UPDATE OF doc'));assert(sql.includes('pg_column_size(doc) INTO STRICT measured FROM'));
  assert(!sql.includes('SECURITY DEFINER'));assert(!sql.includes('pg_notify'));
 });
 it('refuses a storage projection without its already inventoried clinical table',()=>{
  const source=require('../migrations/candidates/postgres-entries-v1.json');
  assert.throws(()=>require('../lib/tenant-operations/catalogues').createdTables({version:1,migrations:[source.migrations.find(m=>m.operation?.kind==='clinical-storage-size-v1')]}),error=>error.code==='OPERATIONS_CENSUS_DDL_UNSUPPORTED');
 });
 it('refuses a weakened typed operation even with its checksum recomputed; restored catalogue passes',()=>{
  const original=require('../migrations/candidates/postgres-entries-v1.json'),broken=structuredClone(original),migration=broken.migrations.find(m=>m.operation?.kind==='clinical-storage-size-v1');
  migration.up=migration.up.map(sql=>sql.replace('AFTER INSERT OR UPDATE OF doc','BEFORE INSERT OR UPDATE OF doc'));migration.checksum=catalogue.checksum(migration.up);
  assert.throws(()=>catalogue.validateCatalogue(broken),error=>error.code==='MIG_OPERATION_SQL');catalogue.validateCatalogue(original);
 });
});


// storage-machinery-removal: 0100 removes the column, its trigger and function
// on every clinical table; nothing reads the statistic any more.
describe('clinical storage-size removal',()=>{
 for(const domain of builder.DOMAINS)it('removes the '+domain+' column, trigger and function after the historical projection',()=>{
  const files=['postgres-'+domain+'-v1.json',...(['treatments','devicestatus','profile'].includes(domain)?['postgres-'+domain+'-socket-order-v1.json']:[])];
  for(const file of files){
   const migrations=catalogue.validateCatalogue(require('../migrations/candidates/'+file)),last=migrations.find(m=>m.operation?.kind==='clinical-storage-size-removal-v1');
   assert.equal(last.name,'0100_'+domain+'_storage_bytes_removed');
   assert.deepEqual(last.operation,{kind:'clinical-storage-size-removal-v1',domain});
   assert.deepEqual(catalogue.renderMigration(last,'synthetic_'+domain),['DROP TRIGGER clinical_storage_size ON "synthetic_'+domain+'"."'+domain+'"','DROP FUNCTION "synthetic_'+domain+'".clinical_storage_size()','ALTER TABLE "synthetic_'+domain+'"."'+domain+'" DROP COLUMN storage_bytes']);
   assert.deepEqual(catalogue.operationTables(last),[]);
   assert(migrations.findIndex(m=>m.operation?.kind==='clinical-storage-size-v1')<migrations.indexOf(last));
  }
 });
 it('leaves no runtime reader of the statistic',()=>{
  const fs=require('node:fs'),path=require('node:path'),root=path.join(__dirname,'..','lib'),hits=[];
  (function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);
   if(entry.isDirectory())visit(file);else if(file.endsWith('.js')&&!file.endsWith('clinical-storage-size-sql.js')&&!file.endsWith('migrations/postgres-check.js')&&fs.readFileSync(file,'utf8').includes('storage_bytes'))hits.push(path.relative(root,file));}})(root);
  assert.deepEqual(hits,[]);
 });
 it('treats the removal as an independent tail and refuses a misnamed or weakened one',()=>{
  const original=require('../migrations/candidates/postgres-entries-v1.json');
  const renamed=structuredClone(original),weak=structuredClone(original);
  const at=m=>m.migrations.find(x=>x.name==='0100_entries_storage_bytes_removed');
  at(renamed).name='0102_entries_storage_bytes_removed';
  assert.throws(()=>catalogue.validateCatalogue(renamed),error=>error.code==='MIG_OPERATION');
  const w=at(weak);w.up=w.up.slice(0,2);w.checksum=catalogue.checksum(w.up);
  assert.throws(()=>catalogue.validateCatalogue(weak),error=>error.code==='MIG_OPERATION_SQL');
  catalogue.validateCatalogue(original);
 });
});
