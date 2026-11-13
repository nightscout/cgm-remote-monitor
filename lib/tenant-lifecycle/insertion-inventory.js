'use strict';

// Reviewed typed catalogue operations, never live schema discovery, establish
// which clinical tables carry a tenant-local insertion counter.
const { validateCatalogue } = require('../migrations/catalogue');
const { refuse, tableKey } = require('./artifact');
const COUNTER = 'tenant_insertion_ordinal';
const DOMAINS = new Set(['entries', 'food', 'treatments', 'devicestatus', 'profile']);
const MAX = 9223372036854775807n;

function hasCounter (candidate, kind) {
  const operations = validateCatalogue(candidate).filter(migration => migration.operation?.kind === 'tenant-insertion-v1');
  if (!operations.length) return false;
  if (!DOMAINS.has(kind) || operations.length !== 1 || operations[0].operation.domain !== kind) {
    throw refuse('LIFECYCLE_COUNTER_CATALOGUE_INVALID', kind);
  }
  return true;
}

function tableOrder (kind, candidate, tables) {
  if (!hasCounter(candidate, kind)) return tables.slice();
  if (!tables.includes(kind) || tables.some(table => table !== kind && table !== COUNTER)) {
    throw refuse('LIFECYCLE_COUNTER_INVENTORY_INVALID', kind);
  }
  return [COUNTER, kind];
}

function assertTables (kind, candidate, tables) {
  if (tableOrder(kind, candidate, tables).join(',') !== tables.join(',')) {
    throw refuse('LIFECYCLE_COUNTER_INVENTORY_INCOMPLETE', kind);
  }
}

function decimal (value, zero = false) {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)) {
    throw refuse('LIFECYCLE_COUNTER_ARTIFACT_INVALID');
  }
  const result = BigInt(value);
  if (result > MAX) throw refuse('LIFECYCLE_COUNTER_ARTIFACT_INVALID');
  return result;
}

// Retain the exact counter, including a floor beyond current surviving rows.
// A maximum derived only from surviving documents is not an equivalent backup.
function assertArtifact (artifact, kind) {
  const counters = artifact.tables[tableKey(kind, COUNTER)];
  const rows = artifact.tables[tableKey(kind, kind)];
  if (!Array.isArray(counters) || !Array.isArray(rows) || counters.length > 1 || (rows.length && counters.length !== 1)) {
    throw refuse('LIFECYCLE_COUNTER_ARTIFACT_INCOMPLETE', kind);
  }
  assertState(counters, rows, kind);
  const floor = counters.length ? decimal(counters[0].last_ordinal, true) : 0n;
  return { floor: floor.toString(), rows: rows.length };
}

function assertState (counters, rows, kind) {
  if (!Array.isArray(counters) || !Array.isArray(rows)) throw refuse('LIFECYCLE_COUNTER_ARTIFACT_INCOMPLETE', kind);
  const floors = new Map();
  for (const row of counters) {
    if (floors.has(row.tenant_id)) throw refuse('LIFECYCLE_COUNTER_ARTIFACT_INVALID', kind);
    floors.set(row.tenant_id, decimal(row.last_ordinal, true));
  }
  const ordinals = new Set();
  for (const row of rows) {
    const ordinal = decimal(row.insertion_ordinal);
    const key = row.tenant_id + ':' + row.insertion_ordinal;
    if (!floors.has(row.tenant_id) || ordinal > floors.get(row.tenant_id) || ordinals.has(key)) throw refuse('LIFECYCLE_COUNTER_ARTIFACT_INVALID', kind);
    ordinals.add(key);
  }
}

module.exports = { COUNTER, hasCounter, tableOrder, assertTables, assertArtifact, assertState };
