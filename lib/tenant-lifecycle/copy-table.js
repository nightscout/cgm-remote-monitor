'use strict';

const { Query, escapeIdentifier, types } = require('pg');
const { parse } = require('csv-parse/sync');

// Use the same PostgreSQL output and input settings across database sessions.
// The final true argument scopes each setting to this tenant transaction.
async function configure (connection) {
  await connection.query("SELECT /* tenant-copy-format */ set_config('DateStyle','ISO,YMD',true)," +
    "set_config('TimeZone','UTC',true),set_config('IntervalStyle','postgres',true)," +
    "set_config('bytea_output','hex',true),set_config('extra_float_digits','3',true)");
}

// COPY uses the same bound connection and repeatable-read snapshot as the ledger
// and catalogue queries. PostgreSQL quotes every non-null value; an unquoted
// empty field is SQL NULL, while "" is the empty string.
async function capture (connection, namespace, table, columns) {
  const selection = columns.map(column => escapeIdentifier(column.name)).join(', ');
  const relation = escapeIdentifier(namespace) + '.' + escapeIdentifier(table);
  const query = new Query('COPY (SELECT ' + selection + ' FROM ' + relation +
    " WHERE tenant_id = current_setting('app.current_tenant_id')::uuid) TO STDOUT WITH (FORMAT CSV, FORCE_QUOTE *, ENCODING 'UTF8')");
  const chunks = [];
  query.handleCopyData = message => chunks.push(message.chunk);
  const completed = new Promise((resolve, reject) => { query.callback = error => error ? reject(error) : resolve(); });
  await Promise.all([connection.query(query), completed]);
  return Buffer.concat(chunks).toString('utf8');
}

function fields (text) {
  return parse(text, { cast: (value, field) => value === '' && !field.quoting ? null : value });
}

// format('%s', value) invokes PostgreSQL's type output function just as COPY
// does. Keep SQL NULL separate from an empty string. This SELECT also runs on
// maintenance connections that permit data statements only.
async function readFields (connection, tenant, namespace, table, columns) {
  const expressions = columns.map(column => {
    const name = escapeIdentifier(column.name);
    return "CASE WHEN " + name + " IS NOT NULL THEN format('%s', " + name + ") END";
  });
  const sql = 'SELECT ARRAY[' + expressions.join(', ') + '] AS copy_fields FROM ' +
    escapeIdentifier(namespace) + '.' + escapeIdentifier(table) + ' WHERE tenant_id = $1';
  return (await connection.query(sql, [tenant])).rows.map(row => row.copy_fields);
}

function decode (records, columns) {
  const readers = columns.map(column => types.getTypeParser(column.oid, 'text'));
  return records.map(values => {
    if (values.length !== columns.length) throw new Error('LIFECYCLE_ARTIFACT_COLUMN_COUNT');
    return Object.fromEntries(columns.map((column, i) => [column.name, values[i] === null ? null : readers[i](values[i])]));
  });
}

function rows (text, columns) {
  return decode(fields(text), columns);
}

module.exports = { configure, capture, fields, readFields, decode, rows };
