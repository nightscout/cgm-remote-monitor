'use strict';

// Source census and explicit deployment admission. Discover reviewed JSON inputs,
// never database schemas or executable runtime modules. Unknown candidates refuse.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./common');
const lifecycle = require('../tenant-lifecycle');
const { validateCatalogue } = require('../migrations/catalogue');
const { refuse } = common;
const ROOT = path.resolve(__dirname, '../..');
const ALTERNATIVES = Object.freeze({
  treatments: 'migrations/candidates/postgres-treatments-socket-order-v1.json',
  devicestatus: 'migrations/candidates/postgres-devicestatus-socket-order-v1.json'
});

function discoverCatalogues (root = ROOT) {
  const found = [];
  function visit (relative) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Explicit reviewed local source root, read-only census.
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw refuse('OPERATIONS_CENSUS_SYMLINK', file);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.json')) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Candidate path enumerated under the reviewed local source root.
        const candidate = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        if (candidate && Object.hasOwn(candidate, 'migrations')) {
          validateCatalogue(candidate);
          found.push({ file, candidate });
        }
      }
    }
  }
  visit('lib');
  visit('migrations/candidates');
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

function createdTables (candidate) {
  const tables = [];
  for (const migration of validateCatalogue(candidate)) {
    for (const sql of migration.up) {
      if (!/\bCREATE\s+TABLE\b/i.test(sql)) continue;
      const match = /^\s*CREATE TABLE (?:IF NOT EXISTS )?"?([a-z][a-z0-9_]+)"?\s*\(([\s\S]*)\)\s*$/i.exec(sql);
      const inherited = match && /^\s*LIKE "?([a-z][a-z0-9_]+)"? INCLUDING CONSTRAINTS(?:,|\s*$)/i.exec(match[2]);
      if (!match || (!/\btenant_id\s+uuid\b/i.test(match[2]) && !(inherited && tables.includes(inherited[1])))) {
        throw refuse('OPERATIONS_CENSUS_DDL_UNSUPPORTED', migration.name);
      }
      if (tables.includes(match[1])) throw refuse('OPERATIONS_CENSUS_TABLE_DUPLICATE', match[1]);
      tables.push(match[1]);
    }
  }
  return tables;
}

// selection: kind -> reviewed candidate path (e.g. optional socket-order successor).
// extensions: [{ kind, candidatePath, tables, secrets? }], explicit and ordered.
// Every newly discovered candidate must enter this admission or an existing
// declared alternative family. No wildcard schema/table selection is accepted.
function deploymentAdmission ({ root = ROOT, namespaces, selection = {}, extensions = [] } = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw refuse('OPERATIONS_CENSUS_SELECTION_INVALID');
  const discovered = discoverCatalogues(root);
  const byPath = new Map(discovered.map(entry => [entry.file, entry.candidate]));
  const known = new Set();
  const home = path.resolve(root) === ROOT ? discovered : discoverCatalogues(ROOT);
  const descriptors = lifecycle.admittedCatalogue().map(entry => {
    const matching = home.filter(item => common.canonical(item.candidate) === common.canonical(entry.candidate));
    if (matching.length !== 1) throw refuse('OPERATIONS_CENSUS_SOURCE_MISMATCH', entry.kind);
    const file = matching[0].file;
    if (!byPath.has(file)) throw refuse('OPERATIONS_CENSUS_SOURCE_MISMATCH', file);
    // The old source archive may contain an older version of the same reviewed
    // family. Census that archive's exact SQL, never substitute target DDL.
    const tables = path.resolve(root) === ROOT ? entry.tables : createdTables(byPath.get(file));
    return { ...entry, tables, candidatePath: file };
  });
  descriptors.push({ kind: 'lifecycle', candidatePath: 'lib/tenant-lifecycle/postgres-candidate.json', tables: createdTables(byPath.get('lib/tenant-lifecycle/postgres-candidate.json')), secrets: [] });
  if (!Array.isArray(extensions)) throw refuse('OPERATIONS_CENSUS_EXTENSION_INVALID');
  for (const extension of extensions) {
    if (!extension || typeof extension.candidateDigest !== 'string' || !common.DIGEST.test(extension.candidateDigest)) throw refuse('OPERATIONS_CENSUS_EXTENSION_INVALID');
    const candidate = byPath.get(extension.candidatePath);
    if (candidate && common.sha256(common.canonical(candidate)) !== extension.candidateDigest) {
      throw refuse('OPERATIONS_CENSUS_EXTENSION_CHANGED', extension.candidatePath);
    }
  }
  descriptors.push(...extensions);
  const kinds = new Set();
  const catalogues = descriptors.map(entry => {
    if (!entry || typeof entry.kind !== 'string' || kinds.has(entry.kind)) throw refuse('OPERATIONS_CENSUS_EXTENSION_INVALID');
    kinds.add(entry.kind);
    const options = [entry.candidatePath];
    if (ALTERNATIVES[entry.kind]) options.push(ALTERNATIVES[entry.kind]);
    for (const file of options) {
      if (!byPath.has(file)) throw refuse('OPERATIONS_CENSUS_SOURCE_MISMATCH', file);
      if (known.has(file)) throw refuse('OPERATIONS_CENSUS_EXTENSION_INVALID', file);
      known.add(file);
    }
    const selected = selection[entry.kind] || entry.candidatePath;
    if (!options.includes(selected)) throw refuse('OPERATIONS_CENSUS_SELECTION_INVALID', entry.kind);
    const candidate = byPath.get(selected);
    const tables = createdTables(candidate);
    if (!Array.isArray(entry.tables) || common.canonical(tables) !== common.canonical(entry.tables)) {
      throw refuse('OPERATIONS_CENSUS_TABLES_MISMATCH', entry.kind);
    }
    return { kind: entry.kind, namespace: namespaces && namespaces[entry.kind], catalogue: candidate,
      tables: entry.tables.slice(), secrets: entry.secrets || [], candidatePath: selected, sourceCommit: entry.sourceCommit || null };
  });
  for (const kind of Object.keys(selection)) if (!kinds.has(kind)) throw refuse('OPERATIONS_CENSUS_SELECTION_INVALID', kind);
  for (const entry of discovered) if (!known.has(entry.file)) throw refuse('OPERATIONS_CATALOGUE_UNADMITTED', entry.file);
  const steps = common.plan(catalogues);
  const census = {
    candidates: discovered.map(entry => ({ file: entry.file, digest: common.sha256(common.canonical(entry.candidate)),
      disposition: catalogues.some(item => item.candidatePath === entry.file) ? 'selected' : 'reviewed alternative' })),
    selected: steps.map((step, index) => ({ kind: step.kind, namespace: step.namespace, candidatePath: catalogues[index].candidatePath,
      catalogueChecksum: step.catalogueChecksum, candidateDigest: common.sha256(common.canonical(catalogues[index].catalogue)),
      admissionSourceCommit: catalogues[index].sourceCommit, tables: step.tables.slice() })),
    tables: steps.reduce((count, step) => count + step.tables.length, 0)
  };
  // Lifecycle retains its separate deletion ledger; ordinary tenant artifacts
  // exclude that ledger. Deployment backup includes it explicitly above.
  const tenantCatalogues = catalogues.filter(entry => entry.kind !== 'lifecycle').map(entry => ({
    kind: entry.kind, candidate: entry.catalogue, tables: entry.tables, secrets: entry.secrets
  }));
  const admissionCheck = ({ catalogues: requested, namespaces: currentNamespaces }) => {
    const fresh = deploymentAdmission({ root, namespaces: { ...namespaces, ...currentNamespaces }, selection, extensions });
    const described = entries => entries.map(entry => ({ kind: entry.kind, tables: entry.tables, candidate: entry.candidate }));
    if (common.canonical(described(requested)) !== common.canonical(described(fresh.lifecycle.CATALOGUE))) throw refuse('OPERATIONS_CENSUS_LIFECYCLE_INCOMPLETE');
  };
  return { catalogues, census, lifecycle: lifecycle.createLifecycle({ catalogues: tenantCatalogues, admissionCheck }) };
}

module.exports = { discoverCatalogues, createdTables, deploymentAdmission };
