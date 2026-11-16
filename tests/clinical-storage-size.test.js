'use strict';
const assert=require('node:assert/strict');
const builder=require('../lib/storage/clinical-storage-size-sql'),catalogue=require('../lib/migrations/catalogue');
describe('typed clinical stored-byte projection migration',()=>{
 for(const domain of builder.DOMAINS)it('appends the exact '+domain+' projection and preserves strict rendering',()=>{
  const source=require('../migrations/candidates/postgres-'+domain+'-v1.json'),migration=catalogue.validateCatalogue(source).at(-1);
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
  assert.throws(()=>require('../lib/tenant-operations/catalogues').createdTables({version:1,migrations:[source.migrations.at(-1)]}),error=>error.code==='OPERATIONS_CENSUS_DDL_UNSUPPORTED');
 });
 it('refuses a weakened typed operation even with its checksum recomputed; restored catalogue passes',()=>{
  const original=require('../migrations/candidates/postgres-entries-v1.json'),broken=structuredClone(original),migration=broken.migrations.at(-1);
  migration.up=migration.up.map(sql=>sql.replace('AFTER INSERT OR UPDATE OF doc','BEFORE INSERT OR UPDATE OF doc'));migration.checksum=catalogue.checksum(migration.up);
  assert.throws(()=>catalogue.validateCatalogue(broken),error=>error.code==='MIG_OPERATION_SQL');catalogue.validateCatalogue(original);
 });
});
