#!/usr/bin/env node
'use strict';

// INC-U operator tool: the treatments fallback-key census and the build rule
// for its partial unique indexes (lib/storage/treatment-key-index.js).
//
//   node tools/treatment-key-index.js census [--table schema.treatments] [--json]
//   node tools/treatment-key-index.js ensure --mode off|try|require [--table schema.treatments]
//   node tools/treatment-key-index.js drop [--table schema.treatments]
//
// ensure adds the column key_exempt (boolean, default false; metadata only),
// marks all but the earliest live row of each equal-key group exempt and
// builds the indexes. drop reverses it: the indexes, then the column. No
// document is written by either.
//
// Connects with NS_POSTGRES_ADMIN_URI (an owner or superuser: the census reads
// every tenant, so row security must not apply, and only the owner can build an
// index). Without --table, every table named `treatments` that has a tenant_id
// column is visited. Prints counts only, never key values or tenant data.
// `ensure` builds with CREATE INDEX CONCURRENTLY, so writes continue.

const { Client } = require('pg');
const keyIndex = require('../lib/storage/treatment-key-index');

function args (argv) {
  const out = { command: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--table') out.table = argv[++i];
    else if (argv[i] === '--mode') out.mode = argv[++i];
    else if (argv[i] === '--json') out.json = true;
    else throw new TypeError('unknown argument ' + argv[i]);
  }
  return out;
}

async function tables (client, only) {
  if (only) return [only];
  const { rows } = await client.query(`SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'treatments' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    ORDER BY 1`);
  return rows.map(row => row.schema + '.treatments');
}

async function main () {
  const o = args(process.argv.slice(2));
  if (!['census', 'ensure', 'drop'].includes(o.command)) throw new TypeError('usage: census|ensure|drop');
  const uri = process.env.NS_POSTGRES_ADMIN_URI;
  if (!uri) throw new TypeError('NS_POSTGRES_ADMIN_URI is required');
  const client = new Client({ connectionString: uri, application_name: 'treatment-key-index' });
  await client.connect();
  const report = { server: (await client.query('SHOW server_version')).rows[0].server_version, tables: [] };
  let failed = false;
  try {
    for (const table of await tables(client, o.table)) {
      if (o.command === 'census') {
        const started = Date.now();
        const result = await keyIndex.census(client, table);
        const sum = key => result.tenants.reduce((n, t) => n + (t[key] || 0), 0);
        report.tables.push({ table, ms: Date.now() - started, tenants: result.tenants.length, live: sum('live'),
          collisions: result.totals, unindexable: sum('unindexable'), multiId: sum('multiId'),
          identifierWithClientId: sum('identifierWithClientId'), identifierOnly: sum('identifierOnly'), exempt: sum('exempt'),
          tenantsWithCollisions: result.tenants.filter(t => Object.keys(t.classes).length).length,
          perTenant: o.json ? result.tenants : undefined });
      } else if (o.command === 'drop') {
        await keyIndex.drop(client, table);
        report.tables.push({ table, dropped: true });
      } else {
        const status = await keyIndex.ensure(client, table, o.mode);
        report.tables.push({ table, status });
        if (status.errors.length) failed = true;
      }
    }
  } finally { await client.end(); }
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 2;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
