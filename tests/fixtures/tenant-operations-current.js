'use strict';

// Actual tenant-operations native fixture inputs, also exercised by recording
// tests. Current counter schemas and the explicit old-binary rollback source
// have different inventories; never substitute the old schema for current tests.
const entries = require('../../migrations/candidates/postgres-entries-v1.json');
const clock = require('../../migrations/candidates/postgres-write-clock-v1.json');
const { createdTables } = require('../../lib/tenant-operations/catalogues');
const common = require('../../lib/tenant-operations/common');
const older = { version: 1, migrations: [entries.migrations[0]] };

function catalogues (ns, old = false) {
  const candidate = old ? older : entries;
  return [
    { kind: 'entries', namespace: ns.entries, catalogue: candidate, tables: createdTables(candidate) },
    { kind: 'clock', namespace: ns.clock, catalogue: clock, tables: createdTables(clock) }
  ];
}

function upgradePlan (ns) {
  return { catalogues: catalogues(ns), sourceCatalogues: catalogues(ns, true) };
}

async function seedEntries (connection, namespace, rows) {
  if (!common.namespaceValid(namespace)) throw new TypeError('Fixture namespace required');
  await connection.query('BEGIN');
  try {
    for (const row of rows) {
      await connection.query("SELECT set_config('app.current_tenant_id',$1,true)", [row.tenant]);
      await connection.query('INSERT INTO "' + namespace + '".entries (tenant_id,id_kind,doc) VALUES ($1,$2,$3::jsonb)',
        [row.tenant, row.kind, JSON.stringify(row.doc)]);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

function applicationAcl (role, old = false) {
  if (old) return { role }; // Explicit pre-counter rollback catalogue only.
  return {
    grants: [
      { role, kind: 'entries', table: 'schema_migrations', privileges: ['SELECT'] },
      { role, kind: 'entries', table: 'entries', privileges: ['SELECT', 'UPDATE', 'DELETE'] },
      { role, kind: 'clock', table: 'schema_migrations', privileges: ['SELECT'] },
      { role, kind: 'clock', table: 'tenant_write_clock', privileges: ['SELECT'] }
    ],
    tenantInsertion: [{ role, kind: 'entries', mode: 'serving' }]
  };
}

async function observe (connection, ns, old = false) {
  for (const namespace of Object.values(ns)) if (!common.namespaceValid(namespace)) throw new TypeError('Fixture namespace required');
  // Independent direct SQL, without artifact codecs or common.summarize.
  const rows = await connection.query('SELECT tenant_id,id_kind,doc FROM "' + ns.entries + '".entries ORDER BY tenant_id,id_kind,doc::text');
  const stamps = await connection.query('SELECT tenant_id,last_stamp FROM "' + ns.clock + '".tenant_write_clock ORDER BY tenant_id');
  const counters = old ? [] : (await connection.query('SELECT tenant_id,last_ordinal FROM "' + ns.entries + '".tenant_insertion_ordinal ORDER BY tenant_id')).rows;
  const ordinals = old ? [] : (await connection.query('SELECT tenant_id,id_kind,doc,insertion_ordinal FROM "' + ns.entries + '".entries ORDER BY tenant_id,insertion_ordinal')).rows;
  return { rows: rows.rows, stamps: stamps.rows, counters, ordinals };
}

module.exports = { upgradePlan, catalogues, seedEntries, applicationAcl, observe, older };
