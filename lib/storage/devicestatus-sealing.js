'use strict';

// The row remains the unique, lockable identity at every age. Its generated
// columns continue to index the original public values. Only the unindexed
// remainder moves to an LZ4-compressed UTC day. Restores use the logical view.
const NAME = '0103_devicestatus_sealed_days';
const KIND = 'devicestatus-sealed-days-v1';
const headerKeys = ['_id', 'created_at', 'device', 'date', 'identifier', 'srvModified', 'isValid'];
const keys = 'ARRAY[' + headerKeys.map(name => "'" + name + "'").join(',') + ']';
const generated = ['"_id"', 'created_at', 'device', '"date"', 'identifier', '"srvModified"', '"isValid"', 'insertion_ordinal', 'event_ms', 'received_ms'];

function build ({ namespace }) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace)) throw new TypeError('Explicit device-status namespace required');
  const ns = '"' + namespace + '"';
  const rows = ns + '.devicestatus_rows';
  const blocks = ns + '.devicestatus_day';
  const view = ns + '.devicestatus';
  const tenant = "NULLIF(current_setting('app.current_tenant_id',true),'')::uuid";
  const returning = ' RETURNING ' + generated.join(',') + ' INTO ' + generated.map(name => 'NEW.' + name).join(',');
  return [
    require('node:fs').readFileSync(require.resolve('./clinical-instant.sql'), 'utf8').trim(),
    'REVOKE ALL ON FUNCTION clinical_instant_ms(jsonb) FROM PUBLIC',
    `ALTER TABLE ${view} RENAME TO devicestatus_rows`,
    `CREATE TABLE ${blocks} (tenant_id uuid NOT NULL, block_id bigint GENERATED ALWAYS AS IDENTITY, day_ms bigint NOT NULL CHECK(day_ms % 86400000 = 0), body jsonb COMPRESSION lz4 NOT NULL CHECK(jsonb_typeof(body)='object'), PRIMARY KEY (tenant_id,block_id))`,
    `ALTER TABLE ${blocks} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${blocks} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY devicestatus_day_tenant ON ${blocks} USING (tenant_id=${tenant}) WITH CHECK (tenant_id=${tenant})`,
    `ALTER TABLE ${rows} ADD COLUMN received_ms bigint, ADD COLUMN block_id bigint, ADD COLUMN sealed_bytes integer, ADD COLUMN event_ms bigint GENERATED ALWAYS AS (${ns}.clinical_instant_ms(doc->'created_at')) STORED, ADD FOREIGN KEY (tenant_id,block_id) REFERENCES ${blocks}(tenant_id,block_id)`,
    `ALTER TABLE ${rows} ALTER COLUMN received_ms SET DEFAULT floor(extract(epoch FROM statement_timestamp())*1000)::bigint`,
    `CREATE INDEX devicestatus_unsealed_event ON ${rows}(tenant_id,event_ms,insertion_ordinal) WHERE block_id IS NULL AND event_ms IS NOT NULL`,
    // A correlated scalar read leaves FOR UPDATE on the identity row. A hot
    // row never touches the day body. Each query sees one MVCC publication.
    `CREATE VIEW ${view} WITH (security_invoker=true) AS SELECT r.tenant_id,
      CASE WHEN r.block_id IS NULL THEN r.doc ELSE r.doc || (SELECT b.body -> r.insertion_ordinal::text
        FROM ${blocks} b WHERE b.tenant_id=r.tenant_id AND b.block_id=r.block_id) END AS doc,
      r.id_kind, ${generated.map(name => 'r.' + name).join(',')}, r.doc AS lookup_doc, COALESCE(r.sealed_bytes,pg_column_size(r.doc)) AS logical_bytes FROM ${rows} r`,
    `ALTER VIEW ${view} ALTER COLUMN received_ms SET DEFAULT floor(extract(epoch FROM statement_timestamp())*1000)::bigint`,
    `CREATE FUNCTION ${ns}.devicestatus_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $write$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.insertion_ordinal IS NULL AND NOT has_column_privilege(current_user,TG_RELID,'received_ms','INSERT') THEN
      INSERT INTO ${rows}(tenant_id,id_kind,doc) VALUES(NEW.tenant_id,NEW.id_kind,NEW.doc)${returning};
    ELSE
      INSERT INTO ${rows}(tenant_id,id_kind,doc,insertion_ordinal,received_ms) VALUES(NEW.tenant_id,NEW.id_kind,NEW.doc,NEW.insertion_ordinal,NEW.received_ms)${returning};
    END IF;
  ELSE
    IF (NEW.tenant_id,NEW.insertion_ordinal) IS DISTINCT FROM (OLD.tenant_id,OLD.insertion_ordinal) THEN
      RAISE EXCEPTION 'TENANT_ORDINAL_IMMUTABLE';
    END IF;
    UPDATE ${rows} SET id_kind=NEW.id_kind, doc=NEW.doc, block_id=NULL, sealed_bytes=NULL
      WHERE tenant_id=OLD.tenant_id AND insertion_ordinal=OLD.insertion_ordinal${returning};
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  NEW.lookup_doc := NEW.doc;
  RETURN NEW;
END
$write$`,
    `REVOKE ALL ON FUNCTION ${ns}.devicestatus_write() FROM PUBLIC`,
    `CREATE TRIGGER devicestatus_write INSTEAD OF INSERT OR UPDATE ON ${view} FOR EACH ROW EXECUTE FUNCTION ${ns}.devicestatus_write()`,
    // Deleting via the automatically updatable view also covers fenced tenant
    // erasure. Concurrent edits of different members serialize on the block.
    `CREATE FUNCTION ${ns}.devicestatus_forget_member() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $forget$
BEGIN
  IF OLD.block_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.block_id IS DISTINCT FROM OLD.block_id) THEN
    UPDATE ${blocks} SET body=body-OLD.insertion_ordinal::text WHERE tenant_id=OLD.tenant_id AND block_id=OLD.block_id;
    DELETE FROM ${blocks} WHERE tenant_id=OLD.tenant_id AND block_id=OLD.block_id AND body='{}'::jsonb;
  END IF;
  RETURN NULL;
END
$forget$`,
    `REVOKE ALL ON FUNCTION ${ns}.devicestatus_forget_member() FROM PUBLIC`,
    `CREATE TRIGGER devicestatus_forget_member AFTER UPDATE OF block_id OR DELETE ON ${rows} FOR EACH ROW WHEN (OLD.block_id IS NOT NULL) EXECUTE FUNCTION ${ns}.devicestatus_forget_member()`,
    // Each call seals a bounded part of the oldest fully eligible day. Never
    // accept a future clock from the caller. Late arrivals start in rows and
    // become another immutable part on a later pass.
    `CREATE FUNCTION ${ns}.devicestatus_seal_day() RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $seal$
DECLARE
  t uuid := ${tenant};
  cutoff bigint := floor((extract(epoch FROM statement_timestamp()) - 172800) / 86400)::bigint * 86400000;
  day_start bigint;
  ordinals bigint[];
  payload jsonb;
  new_block bigint;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'TENANT_ORDINAL_BINDING_REQUIRED'; END IF;
  -- A writer takes KEY SHARE before its locking read. Its next statement
  -- then sees both the published row reference and the new day body.
  PERFORM 1 FROM ${ns}.tenant_insertion_ordinal WHERE tenant_id=t FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT floor(event_ms::numeric/86400000)::bigint*86400000 INTO day_start FROM ${rows}
    WHERE tenant_id=t AND block_id IS NULL AND event_ms<cutoff ORDER BY event_ms,insertion_ordinal LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  WITH locked AS MATERIALIZED (
    SELECT insertion_ordinal,doc FROM ${rows} WHERE tenant_id=t AND block_id IS NULL
      AND event_ms>=day_start AND event_ms<day_start+86400000 ORDER BY event_ms,insertion_ordinal LIMIT 512 FOR UPDATE
  ), members AS (
    SELECT *,sum(octet_length(doc::text)::bigint) OVER (ORDER BY insertion_ordinal) AS bytes FROM locked
  )
  SELECT array_agg(insertion_ordinal),jsonb_object_agg(insertion_ordinal::text,doc-${keys}) INTO ordinals,payload
    FROM members WHERE bytes-octet_length(doc::text)<4194304;
  IF ordinals IS NULL THEN RETURN 0; END IF;
  INSERT INTO ${blocks}(tenant_id,day_ms,body) VALUES(t,day_start,payload) RETURNING block_id INTO new_block;
  UPDATE ${rows} r SET block_id=new_block,sealed_bytes=pg_column_size(r.doc),doc=(SELECT jsonb_object_agg(k,r.doc->k) FROM unnest(${keys}) k WHERE r.doc ? k)
    WHERE r.tenant_id=t AND r.insertion_ordinal=ANY(ordinals);
  RETURN cardinality(ordinals);
END
$seal$`,
    `REVOKE ALL ON FUNCTION ${ns}.devicestatus_seal_day() FROM PUBLIC`
  ];
}

const selected = catalogue => catalogue?.migrations?.some(m => m.operation?.kind === KIND) === true;

function grants ({ namespace, role, mode }) {
  if (!['serving', 'reader', 'restore'].includes(mode) ||
      ![namespace, role].every(n => typeof n === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(n))) throw new TypeError('Invalid sealing grant identifier');
  const ns = '"' + namespace + '"', who = '"' + role + '"';
  const read = [`GRANT SELECT ON ${ns}.devicestatus_rows,${ns}.devicestatus_day TO ${who}`];
  if (mode === 'reader') return read;
  const restore = mode === 'restore';
  return [...read,
    `REVOKE INSERT ON ${ns}.devicestatus_rows FROM ${who}`,
    `GRANT INSERT(tenant_id,id_kind,doc${restore ? ',insertion_ordinal,received_ms' : ''}), UPDATE(id_kind,doc,block_id,sealed_bytes), DELETE ON ${ns}.devicestatus_rows TO ${who}`,
    `GRANT UPDATE(body), DELETE ON ${ns}.devicestatus_day TO ${who}`,
    `GRANT EXECUTE ON FUNCTION ${ns}.clinical_instant_ms(jsonb),${ns}.devicestatus_write(),${ns}.devicestatus_forget_member() TO ${who}`,
    ...(restore ? [`GRANT INSERT(received_ms) ON ${ns}.devicestatus TO ${who}`,
      `GRANT INSERT(tenant_id,day_ms,body) ON ${ns}.devicestatus_day TO ${who}`,
      `GRANT EXECUTE ON FUNCTION ${ns}.devicestatus_seal_day() TO ${who}`] : [])
  ];
}
module.exports = { NAME, KIND, build, grants, selected, headerKeys: Object.freeze(headerKeys) };
