'use strict';

// Native semantic mutations are authored only. None has been executed against
// a database/listener/provider. The lead must bind each original/mutant source.
const crypto = require('node:crypto');
const mutations = Object.freeze([
  { name: 'project-containment', file: 'lib/subject-admin/owner-policy.js',
    before: '!permissionsContained(permissions, project)', after: 'false /* authority project omission */',
    oracle: 'project-containment rejects role without any owner effect' },
  { name: 'operator-containment', file: 'lib/subject-admin/owner-policy.js',
    before: '!permissionsContained(permissions, current.ceiling)', after: 'false /* authority operator omission */',
    oracle: 'operator-containment rejects role without any owner effect' },
  { name: 'delegation-containment', file: 'lib/subject-admin/owner-policy.js',
    before: '!permissionsContained(permissions, current.delegation)', after: 'false /* authority delegation omission */',
    oracle: 'delegation-containment rejects role without any owner effect' },
  { name: 'actor-fence', file: 'lib/subject-admin/owner-policy.js',
    before: 'currentActor.active !== true || currentActor.can_update !== true',
    after: 'false /* authority actor omission */',
    oracle: 'prior-actor native waiter resumes after committed deactivation but no owner mutation may persist' },
  { name: 'role-share-lock', file: 'lib/subject-admin/owner-policy.js',
    before: "' WHERE tenant_id=$1 AND name=ANY($2::text[]) ORDER BY name FOR SHARE'",
    after: "' WHERE tenant_id=$1 AND name=ANY($2::text[]) ORDER BY name'",
    oracle: 'held-role narrowing must be observed blocked by the native owner PID until owner commit' },
  { name: 'policy-share-lock', file: 'lib/subject-admin/owner-policy.js',
    before: "' WHERE tenant_id=$1 FOR SHARE', [actor.tenant])).rows[0];\n    const currentActor",
    after: "' WHERE tenant_id=$1', [actor.tenant])).rows[0];\n    const currentActor",
    oracle: 'held-policy narrowing must be observed blocked by the native owner PID until owner commit' },
  { name: 'issuance-audit', file: 'lib/subject-admin/postgres.js',
    before: "await record(actor, subjectId, 'issue');", after: '/* authority issuance audit omission */',
    oracle: 'audit failure refuses before derivation and commit trigger must prevent credential return' },
  { name: 'commit-error', file: 'lib/storage/postgres-connection.js',
    before: "const committed = await queryInTransaction(transaction, 'COMMIT');",
    after: "let committed; try { committed = await queryInTransaction(transaction, 'COMMIT'); } catch { committed = { command: 'COMMIT' }; }",
    oracle: 'deferred commit refusal must return503 with error-only body, not a derived credential' }
]);

function materialize (source, name) {
  const mutation = mutations.find(value => value.name === name);
  if (!mutation || source.split(mutation.before).length !== 2) throw new Error('AUTHORITY_NATIVE_MUTANT_ANCHOR_REQUIRED');
  const mutant = source.replace(mutation.before, mutation.after);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  return { ...mutation, sourceSha256: sha(source), mutantSha256: sha(mutant), mutant,
    execution: 'NOTEXECUTED', expected: 'named native oracle must fail; restore original before next case' };
}

module.exports = { mutations, materialize, nativeExecution: 'NOTEXECUTED' };
