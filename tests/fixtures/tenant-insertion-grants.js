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
  const sealing = require('../../lib/storage/devicestatus-sealing');
  const backing = catalogue.migrations.some(m => m.operation?.kind === sealing.KIND) ? sealing.grants({namespace, role, mode}) : [];
  if (mode === 'reader') return [...backing, 'GRANT SELECT ON ' + table + ' TO ' + who,
    ...(ordered ? ['GRANT SELECT ON ' + quote(namespace) + '.tenant_insertion_ordinal TO ' + who] : [])];
  // The catalogue's windowed time column calls a function migration 0001 revokes
  // from PUBLIC; inserting and updating roles need EXECUTE on it (as production
  // ordinary-deployment-grants insertionGrants grants).
  const windowFunction = ['window_time_ms', 'window_time_text'].find(name =>
    JSON.stringify(catalogue?.migrations || []).includes('CREATE FUNCTION ' + name + '('));
  const base = ['GRANT SELECT,INSERT,UPDATE,DELETE ON ' + table + ' TO ' + who,
    ...(windowFunction ? ['GRANT EXECUTE ON FUNCTION ' + quote(namespace) + '.' + windowFunction + '(jsonb) TO ' + who] : [])];
  const timeKeys = catalogue?.migrations.some(m => m.name === '0104_' + domain + '_clinical_time');
  if (timeKeys) {
    base.push('GRANT EXECUTE ON FUNCTION ' + quote(namespace) + '.clinical_instant_ms(jsonb) TO ' + who);
  }
  if (ordered) {
    const built = proposal.build({ namespace, domain });
    return [...base, ...(mode === 'restore' ? built.restoreGrants(role) : built.servingGrants(role)), ...backing,
      ...(timeKeys && mode === 'restore' ? ['GRANT INSERT(received_ms) ON ' + table + ' TO ' + who] : []),
      ...(mode === 'restore' ? ['GRANT DELETE ON ' + quote(namespace) + '.tenant_insertion_ordinal TO ' + who] : [])];
  }
  return [...base, 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA ' + quote(namespace) + ' TO ' + who];
}
async function grant (client, options) { for (const sql of statements(options)) await client.query(sql); }
async function withTenant (client, tenant, fn) {
  if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant) || typeof fn !== 'function') throw new TypeError('Explicit fixture tenant and operation required');
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
    const result = await fn(); await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
module.exports = { statements, grant, withTenant };
