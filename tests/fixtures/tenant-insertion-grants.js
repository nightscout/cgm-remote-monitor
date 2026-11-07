'use strict';

// Fixture-only exact grants for the selected source catalogue. Never changes a
// parent/PUBLIC role or discovers schema objects to adopt. Existing non-ordinal
// catalogues keep their original grants; advanced catalogues use column INSERT.
const admission = require('../../lib/storage/postgres-insertion-readiness');
const proposal = require('../../lib/tenant-lifecycle/tenant-insertion-sql');
const quote = name => {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith('pg_')) throw new TypeError('Explicit fixture SQL name required');
  return '"' + name + '"';
};
function statements ({ namespace, domain, role, catalogue, mode = 'serving' }) {
  const table = quote(namespace) + '.' + quote(domain), who = quote(role);
  if (!['serving', 'reader', 'restore'].includes(mode)) throw new TypeError('Explicit fixture role mode required');
  const ordered = admission.isOrderedCatalogue(catalogue);
  if (mode === 'reader') return ['GRANT SELECT ON ' + table + ' TO ' + who,
    ...(ordered ? ['GRANT SELECT ON ' + quote(namespace) + '.tenant_insertion_ordinal TO ' + who] : [])];
  const base = ['GRANT SELECT,INSERT,UPDATE,DELETE ON ' + table + ' TO ' + who];
  if (ordered) {
    const built = proposal.build({ namespace, domain });
    return [...base, ...(mode === 'restore' ? built.restoreGrants(role) : built.servingGrants(role)),
      ...(mode === 'restore' ? ['GRANT DELETE ON ' + quote(namespace) + '.tenant_insertion_ordinal TO ' + who] : [])];
  }
  return [...base, 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA ' + quote(namespace) + ' TO ' + who];
}
async function grant (client, options) { for (const sql of statements(options)) await client.query(sql); }
module.exports = { statements, grant };
