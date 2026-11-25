'use strict';

// Independent observer: pg_catalog + raw SQL only. No backup encoder, summary,
// row digest, migration-state reader or lifecycle verification is imported.
const assert = require('node:assert/strict');
const quote = name => { assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/); return '"' + name + '"'; };
function ordered (value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
const sorted = rows => rows.map(ordered).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
async function physical (observer, catalogues) {
  const result = {};
  for (const entry of catalogues) {
    const schema = quote(entry.namespace);
    const ledger = (await observer.query('SELECT name,checksum FROM ' + schema + '.schema_migrations ORDER BY name')).rows;
    for (const table of entry.tables) {
      const qualified = schema + '.' + quote(table);
      const columns = (await observer.query("SELECT attname,format_type(atttypid,atttypmod) AS type,attidentity,attgenerated,attnotnull FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum", [qualified])).rows;
      const rows = (await observer.query('SELECT * FROM ' + qualified)).rows;
      const constraints = (await observer.query('SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname', [qualified])).rows;
      const relations = (await observer.query("SELECT c.relname,c.relkind,c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','f','m','v') ORDER BY c.relname", [entry.namespace])).rows;
      const inheritance = (await observer.query('SELECT cn.nspname AS child_namespace,ch.relname AS child_name,pn.nspname AS parent_namespace,pa.relname AS parent_name FROM pg_inherits i JOIN pg_class ch ON ch.oid=i.inhrelid JOIN pg_namespace cn ON cn.oid=ch.relnamespace JOIN pg_class pa ON pa.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=pa.relnamespace WHERE i.inhrelid=$1::regclass OR i.inhparent=$1::regclass ORDER BY cn.nspname,ch.relname,pn.nspname,pa.relname', [qualified])).rows;
      const policies = (await observer.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [qualified])).rows;
      const sequences = (await observer.query('SELECT sequencename,start_value,increment_by,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename', [entry.namespace])).rows;
      const isolation = (await observer.query('SELECT polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) AS using,pg_get_expr(polwithcheck,polrelid) AS check FROM pg_policy WHERE polrelid=$1::regclass ORDER BY polname', [qualified])).rows;
      result[entry.kind + '.' + table] = { ledger, columns, rows: sorted(rows), constraints, policies, isolation, sequences, relations, inheritance };
    }
  }
  return result;
}
function sameRows (before, after) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'WHOLE_C_PHYSICAL_INVENTORY');
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key].rows, before[key].rows, 'WHOLE_C_PHYSICAL_ROWS ' + key);
    assert.deepEqual(after[key].ledger, before[key].ledger, 'WHOLE_C_PHYSICAL_LEDGER ' + key);
    assert.deepEqual(after[key].columns, before[key].columns, 'WHOLE_C_PHYSICAL_COLUMNS ' + key);
    assert.deepEqual(after[key].policies, before[key].policies, 'WHOLE_C_PHYSICAL_RLS ' + key);
    assert.deepEqual(after[key].relations, before[key].relations, 'WHOLE_C_PHYSICAL_RELATIONS ' + key);
    assert.deepEqual(after[key].inheritance, before[key].inheritance, 'WHOLE_C_PHYSICAL_INHERITANCE ' + key);
    assert.deepEqual(after[key].isolation, before[key].isolation, 'WHOLE_C_PHYSICAL_ISOLATION ' + key);
  }
}
function preserved (before, after) {
  for (const [key, value] of Object.entries(before)) {
    assert.ok(after[key], 'WHOLE_C_OLD_TABLE ' + key);
    const names = value.columns.map(column => column.attname);
    assert.deepEqual(sorted(after[key].rows.map(row => Object.fromEntries(names.map(name => [name, row[name]])))), value.rows, 'WHOLE_C_OLD_ROWS ' + key);
  }
}
// Independent closed-file validation, including SQL row projection. No artifact
// serializer/decoder/digest implementation is imported. Call before any NEW up.

module.exports = { physical, sameRows, preserved, sorted, quote };
