'use strict';

// Deployment backup: one REPEATABLE READ, READ ONLY snapshot of every
// catalogued table in every listed namespace, for every tenant, as a manifest
// plus one newline-delimited JSON file per table. The artifact carries the
// migration ledger of each namespace, the catalogue checksum the binary
// knows, the application commit, per-table counts and digests, per-tenant row
// counts, and for the secrets tables the key references parsed from the
// stored ciphertext. Key material never appears: the secrets component keeps
// it, and the ciphertext travels exactly as stored.

const common = require('./common');

const { refuse, tableKey } = common;

async function captureTables (connection, step) {
  const tables = [];
  const files = {};
  for (const table of step.tables) {
    const key = tableKey(step.kind, table);
    const columns = await common.columnsOf(connection, step.namespace, table);
    const rows = await common.readRows(connection, step.namespace, table, columns);
    const encoded = common.encodeTable(rows);
    const described = { table, file: 'tables/' + key + '.ndjson', columns, count: encoded.count, digest: encoded.digest, tenants: common.tenantCounts(rows) };
    if (step.secrets.includes(table)) described.keyReferences = common.keyReferences(rows, key);
    tables.push(described);
    files[key] = encoded.text;
  }
  return { tables, files };
}

function registryOf (manifestCatalogues, registry) {
  if (!registry) return null;
  const catalogue = manifestCatalogues.find(c => c.kind === registry.kind);
  const table = catalogue && catalogue.tables.find(t => t.table === registry.table);
  if (!table) throw refuse('BACKUP_REGISTRY_MISSING', tableKey(registry.kind, registry.table));
  return table;
}

// backup(connection, { catalogues, sourceCommit, registry?, now? })
//   catalogues: [{ kind, namespace, catalogue, tables, secrets? }]
//   registry:   { kind, table } naming the tenant registry (access_tenants);
//               when given, every tenant seen in any table must be registered.
// Returns { format, version, manifest, tables: { 'kind.table': ndjson }, digest }.
async function backup (connection, { catalogues, sourceCommit, registry = null, now } = {}) {
  const steps = common.plan(catalogues);
  if (typeof sourceCommit !== 'string' || !common.COMMIT.test(sourceCommit)) throw refuse('BACKUP_SOURCE_COMMIT_INVALID');
  const takenAt = common.timestamp(now);
  const captured = await common.transaction(connection, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async () => {
    const identity = await common.assertUnboundIdentity(connection, 'BACKUP_IDENTITY_BOUND');
    const manifestCatalogues = [];
    const files = {};
    for (const step of steps) {
      const ledger = await common.readLedger(connection, step.namespace);
      if (!ledger.length) throw refuse('BACKUP_LEDGER_EMPTY', step.kind);
      const prefix = common.ledgerPrefix(ledger, step.files);
      if (!prefix.ok) throw refuse('BACKUP_LEDGER_UNKNOWN', step.kind + ' ' + prefix.reason + ' ' + prefix.name);
      await common.assertRelationInventory(connection, step);
      const tables = await captureTables(connection, step);
      Object.assign(files, tables.files);
      manifestCatalogues.push({ kind: step.kind, namespace: step.namespace, catalogueChecksum: step.catalogueChecksum, ledger, tables: tables.tables });
    }
    return { identity, manifestCatalogues, files };
  });
  const tenants = new Map();
  for (const catalogue of captured.manifestCatalogues) {
    for (const table of catalogue.tables) {
      for (const [tenant, count] of Object.entries(table.tenants)) {
        if (!tenants.has(tenant)) tenants.set(tenant, { tenant_id: tenant, registered: null, rows: {} });
        tenants.get(tenant).rows[tableKey(catalogue.kind, table.table)] = count;
      }
    }
  }
  const registryTable = registryOf(captured.manifestCatalogues, registry);
  if (registryTable) {
    const registered = new Set(common.decodeTable(captured.files[tableKey(registry.kind, registry.table)]).map(row => row.tenant_id));
    for (const tenant of tenants.values()) {
      tenant.registered = registered.has(tenant.tenant_id);
      if (!tenant.registered) throw refuse('BACKUP_TENANT_UNREGISTERED', tenant.tenant_id);
    }
  }
  const manifest = {
    format: common.FORMAT,
    version: common.VERSION,
    takenAt,
    sourceCommit,
    identity: captured.identity,
    registry: registry ? { kind: registry.kind, table: registry.table } : null,
    catalogues: captured.manifestCatalogues.map(catalogue => ({
      ...catalogue,
      tables: catalogue.tables.map(table => {
        const copy = { ...table };
        delete copy.tenants;
        return copy;
      })
    })),
    tenants: [...tenants.values()].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id, 'en'))
  };
  return { format: common.FORMAT, version: common.VERSION, manifest, tables: captured.files, digest: common.manifestDigest(manifest) };
}

// An artifact on disk is `manifest.json` plus `tables/<kind>.<table>.ndjson`.
function serialize (artifact) {
  const files = { 'manifest.json': JSON.stringify({ manifest: artifact.manifest, digest: artifact.digest }, null, 2) + '\n' };
  for (const catalogue of artifact.manifest.catalogues) {
    for (const table of catalogue.tables) files[table.file] = artifact.tables[tableKey(catalogue.kind, table.table)];
  }
  return files;
}

function deserialize (files) {
  let head;
  try { head = JSON.parse(files['manifest.json']); } catch { throw refuse('RESTORE_ARTIFACT_INVALID', 'manifest.json'); }
  if (!head || !head.manifest || !Array.isArray(head.manifest.catalogues)) throw refuse('RESTORE_ARTIFACT_INVALID', 'manifest.json');
  const tables = {};
  for (const catalogue of head.manifest.catalogues) {
    for (const table of catalogue.tables || []) {
      if (typeof files[table.file] !== 'string') throw refuse('RESTORE_ARTIFACT_INVALID', table.file);
      tables[tableKey(catalogue.kind, table.table)] = files[table.file];
    }
  }
  return { format: head.manifest.format, version: head.manifest.version, manifest: head.manifest, tables, digest: head.digest };
}

// The artifact's name: when it was taken and the first bytes of its digest.
const artifactName = artifact => 'deployment-backup-' + new Date(artifact.manifest.takenAt).toISOString().replace(/[:.]/g, '-') +
  '-' + artifact.digest.slice(0, 12);

// The independent oracle over a live tree: the same catalogues, any connection
// with an unbound identity, no artifact involved.
const summarize = (connection, catalogues) => common.summarize(connection, common.plan(catalogues));

module.exports = { backup, serialize, deserialize, artifactName, summarize, compareSummaries: common.compareSummaries, assertSameSummary: common.assertSameSummary };
