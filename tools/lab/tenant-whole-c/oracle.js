'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Explicit owned artifact root and constrained per-manifest relative files. */

// Independent observer: pg_catalog + raw SQL only. No backup encoder, summary,
// row digest, migration-state reader or lifecycle verification is imported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
      const policies = (await observer.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [qualified])).rows;
      const sequences = (await observer.query('SELECT sequencename,start_value,increment_by,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename', [entry.namespace])).rows;
      const isolation = (await observer.query('SELECT polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) AS using,pg_get_expr(polwithcheck,polrelid) AS check FROM pg_policy WHERE polrelid=$1::regclass ORDER BY polname', [qualified])).rows;
      result[entry.kind + '.' + table] = { ledger, columns, rows: sorted(rows), constraints, policies, isolation, sequences, relations };
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
async function artifact (directory, before, emit) {
  const names = (await fs.promises.readdir(directory)).filter(name => /^deployment-backup-[0-9TZ-]+-[a-f0-9]{12}$/.test(name));
  assert.equal(names.length, 1, 'WHOLE_C_ARTIFACT_PUBLICATION');
  const root = path.join(directory, names[0]);
  const privateFile = async file => {
    const stat = await fs.promises.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid());
    return fs.promises.readFile(file, 'utf8');
  };
  const head = JSON.parse(await privateFile(path.join(root, 'manifest.json')));
  const files = {};
  for (const entry of head.manifest.catalogues) for (const table of entry.tables) {
    assert.match(table.file, /^tables\/[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.ndjson$/);
    const text = await privateFile(path.join(root, table.file));
    const rows = text === '' ? [] : text.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.ok(!Object.hasOwn(files, entry.kind + '.' + table.table), 'WHOLE_C_ARTIFACT_DUPLICATE');
    files[entry.kind + '.' + table.table] = { rows: sorted(rows), textDigest: crypto.createHash('sha256').update(text).digest('hex'), columns: table.columns, count: table.count, expectedDigest: table.digest, ledger: entry.ledger };
  }
  await emit({ name: names[0], head, files }); // Physical readback precedes verdict.
  assert.deepEqual(Object.keys(files).sort(), Object.keys(before).sort(), 'WHOLE_C_ARTIFACT_INVENTORY');
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(ordered(head.manifest))).digest('hex'), head.digest, 'WHOLE_C_ARTIFACT_HEADER_DIGEST');
  for (const [key, file] of Object.entries(files)) {
    assert.equal(file.textDigest, file.expectedDigest, 'WHOLE_C_ARTIFACT_FILE_DIGEST ' + key);
    assert.equal(file.rows.length, file.count, 'WHOLE_C_ARTIFACT_FILE_COUNT ' + key);
    const columns = file.columns.map(column => column.name);
    const expected = sorted(before[key].rows.map(row => Object.fromEntries(columns.map(name => [name, row[name]]))));
    assert.deepEqual(file.rows, expected, 'WHOLE_C_ARTIFACT_SQL_ROWS ' + key);
    assert.deepEqual(file.ledger, before[key].ledger, 'WHOLE_C_ARTIFACT_LEDGER ' + key);
  }
  return head;
}
module.exports = { physical, sameRows, preserved, sorted, quote, artifact };
