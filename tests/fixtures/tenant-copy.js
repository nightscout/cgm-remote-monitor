'use strict';

const { stringify } = require('csv-stringify/sync');
const { prepareValue } = require('pg/lib/utils');

// Emulate PostgreSQL's CSV output for the recording database and altered lab
// artifacts. The production exporter receives the bytes from COPY TO STDOUT.
function csv (columns, rows) {
  return stringify(rows.map(row => columns.map(({ name, type }) => {
    const value = row[name];
    if (value == null) return null;
    if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
    if (type === 'boolean') return value ? 't' : 'f';
    return String(prepareValue(value));
  })), { quoted_string: true, quoted_empty: false });
}

function build (input) {
  return require('../../lib/tenant-lifecycle/artifact').buildArtifact({
    ...input,
    catalogues: input.catalogues.map(entry => ({
      ...entry, tables: entry.tables.map(table => ({ ...table, copy: csv(table.columns, table.rows) }))
    }))
  });
}

module.exports = { csv, build };
