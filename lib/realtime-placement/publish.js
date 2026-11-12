'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const c = require('../server/realtime/contract');
const placement = require('./index');
const publication = require('./publication-lock');
const fail = code => { throw Object.assign(new Error(code), { code }); };
// The caller supplies a dedicated direct PostgreSQL client, a narrowly admitted
// registry page reader and an actual platform termination/fence verifier. This is
// operator control, never an endpoint selected by an untrusted client request.
async function publish ({ file, candidate, internal, client, controlNamespace, registry, maxTenants = 10000, confirmStopped, stopOwners, afterAssignment, maxBytes = 1048576, source = process.env }) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !registry || typeof registry.page !== 'function' || typeof registry.revision !== 'function' || !c.integer(maxTenants, 100000) || typeof confirmStopped !== 'function' || !client || typeof client.query !== 'function') throw new TypeError('Explicit bounded publication inputs required');
  if (stopOwners !== undefined && typeof stopOwners !== 'function') throw new TypeError('Explicit platform stop callback required');
  if (afterAssignment !== undefined && typeof afterAssignment !== 'function') throw new TypeError('Explicit target preparation callback required');
  candidate = structuredClone(candidate);
  const bytes = Buffer.from(JSON.stringify(candidate) + '\n');
  if (bytes.length > maxBytes) fail('REALTIME_PLACEMENT_OVER_BOUND');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('REALTIME_PLACEMENT_FILE_REFUSED');
  const lock = publication.key(controlNamespace), next = placement.parse(candidate, { internal, maxBytes });
  let temporary, began = false;
  try {
    await client.query('BEGIN READ ONLY'); began = true;
    const held = (await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS held', [lock])).rows[0];
    if (held?.held !== true) fail('REALTIME_PLACEMENT_MAINTENANCE_PINNED');
    await require('../tenant-lifecycle/operation-window-readiness').admit(client, controlNamespace);
    const previous = placement.parse(c.file(file, { label: 'MULTITENANT_REALTIME_PLACEMENT', source }), { internal, maxBytes });
    let selected = previous;
    const revisions = placement.create({ read: () => selected, continuous: true }); revisions.current(); selected = next; revisions.current();
    if (next.generation !== previous.generation + 1) fail('REALTIME_PLACEMENT_REVISION_REFUSED');
    const registryRevision = await registry.revision(), tenants = []; let after = null;
    for (;;) {
      const limit = Math.min(1000, maxTenants + 1 - tenants.length);
      const page = await registry.page(after, limit);
      if (page.revision !== registryRevision || page.tenants.some(tenant => !c.uuid(tenant) || after !== null && tenant <= after)) fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
      tenants.push(...page.tenants);
      if (tenants.length > maxTenants || new Set(tenants).size !== tenants.length) fail('REALTIME_PLACEMENT_OVER_BOUND');
      if (page.tenants.length < limit) break;
      after = page.tenants.at(-1);
    }
    let affected = 0;
    for (const tenant of tenants) {
      const shard = placement.shard(tenant, next.shardCount), a = previous.owners[shard], b = next.owners[shard];
      if (a?.worker === b?.worker && a?.incarnation === b?.incarnation) continue;
      affected++;
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const row = (await client.query('SELECT phase,lock_key::text AS lock_key FROM "' + controlNamespace + '".tenant_lifecycle_windows WHERE tenant_id=$1', [tenant])).rows[0];
      if (row?.phase !== 'active' || row.lock_key !== require('../tenant-registry/rules').lockKey(tenant)) fail('LIFECYCLE_WINDOW_SUSPENDED');
    }
    if (await registry.revision() !== registryRevision) fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
    // Planned drain/termination happens INSIDE the publication fence, before a
    // pinned restore can select the old actor. Already-confirmed crash recovery
    // needs no stop callback; an ambiguous live owner remains unavailable.
    for (const owner of candidate.transition.stopped) {
      if (await confirmStopped(Object.freeze({ ...owner })) !== true) {
        if (!stopOwners) fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
        await stopOwners(Object.freeze({ ...owner }));
      }
    }
    // Confirm again immediately before publication; an old owner that may still
    // run cannot be replaced. DB resource expiry/readiness is never this proof.
    for (const owner of candidate.transition.stopped) if (await confirmStopped(Object.freeze({ ...owner })) !== true) fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
    if (await registry.revision() !== registryRevision) fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
    temporary = path.join(path.dirname(file), '.realtime-placement-' + randomBytes(12).toString('hex'));
    const handle = await fs.open(temporary, 'wx', stat.mode & 0o777);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file); temporary = null;
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    const result = Object.freeze({ generation: next.generation, digest: next.digest, affectedTenants: affected });
    // New processes warm and the matching route view is published while this
    // same fence still excludes maintenance. Failure retains the new intended
    // assignment as an explicit uncertain transition, never an old-map rollback.
    if (afterAssignment) await afterAssignment(result);
    await client.query('COMMIT'); began = false;
    return result;
  } catch (error) {
    // A failure after rename is uncertain publication, never an instruction to
    // restore an old generation. Read the authoritative file and recover through
    // a fresh confirmed generation; maintenance stays conservatively refused.
    if (began) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}
module.exports = { publish };
