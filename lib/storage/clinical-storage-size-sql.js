'use strict';
// A typed projection of the existing tenant logical-storage statistic. PostgreSQL
// measures the stored datum after TOAST, so JSON text length is not substituted.
const DOMAINS=Object.freeze(require('../tenant-lifecycle/clinical-catalogue').CLINICAL.filter(domain=>domain!=='settings'));
function build({namespace,domain}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||namespace.startsWith('pg_')||['public','information_schema'].includes(namespace)||!DOMAINS.includes(domain))throw new TypeError('CLINICAL_STORAGE_SIZE_BINDING');
 const schema='"'+namespace+'"',table=schema+'."'+domain+'"',fn=schema+'.clinical_storage_size';
 return [
  'LOCK TABLE '+table+' IN ACCESS EXCLUSIVE MODE',
  'SET LOCAL row_security = off',
  'ALTER TABLE '+table+' ADD COLUMN storage_bytes bigint CHECK (storage_bytes>=0)',
  'UPDATE '+table+' SET storage_bytes=pg_column_size(doc)',
  'ALTER TABLE '+table+' ALTER COLUMN storage_bytes SET NOT NULL',
  'ALTER TABLE '+table+' ALTER COLUMN storage_bytes SET DEFAULT 0',
  'CREATE FUNCTION '+fn+'() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $clinical_size$\nDECLARE measured bigint;\nBEGIN\n'+
   '  SELECT pg_column_size(doc) INTO STRICT measured FROM '+table+' WHERE tenant_id=NEW.tenant_id AND id_kind=NEW.id_kind AND "_id"=NEW."_id";\n'+
   '  UPDATE '+table+' SET storage_bytes=measured WHERE tenant_id=NEW.tenant_id AND id_kind=NEW.id_kind AND "_id"=NEW."_id" AND storage_bytes IS DISTINCT FROM measured;\n'+
   '  RETURN NULL;\nEND\n$clinical_size$',
  'REVOKE ALL ON FUNCTION '+fn+'() FROM PUBLIC',
  'CREATE TRIGGER clinical_storage_size AFTER INSERT OR UPDATE OF doc ON '+table+' FOR EACH ROW EXECUTE FUNCTION '+fn+'()',
  'SET LOCAL row_security = on'
 ];
}
module.exports={build,DOMAINS};
