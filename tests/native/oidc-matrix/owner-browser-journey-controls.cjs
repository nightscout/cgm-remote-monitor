'use strict';

// These native semantic mutants are authored plans, NOTEXECUTED. The acceptance
// lead materializes them only in source-bound owned scratch under its grant.
const { createHash } = require('node:crypto');
const native = Object.freeze({
  csrf: { file: 'lib/human-session/http.js',
    before: 'if (supplied.cookie && !SAFE.has(req.method)) {', after: 'if (false) {',
    symptom: 'owner cookie mutation with invalid CSRF reaches200/effect instead of403/no effect' },
  origin: { file: 'lib/human-session/http.js',
    before: 'sameOrigin(req, tenant, supplied.cookie && !SAFE.has(req.method));', after: '/* native origin omission */',
    symptom: 'foreign-origin cookie mutation reaches200 instead of403' },
  sensitive: { file: 'lib/server/subject-management-app.js',
    before: "app.post(PATH + '/:_id/credential', protect(true), jsonOnly,",
    after: "app.post(PATH + '/:_id/credential', protect(false), jsonOnly,",
    symptom: 'aged cookie/bearer privileged issuance returns200 instead of403' },
  freshness: { file: 'lib/human-session/engine.js',
    before: "if (sensitive && session.authenticatedAt + 300 <= at) throw fail('HUMAN_REAUTH_REQUIRED');",
    after: '/* native sensitive freshness omission */',
    symptom: 'aged native management session creates a grant/credential instead of refusing403' },
  authority: { file: 'lib/human-session/postgres.js',
    before: "purposes: first.purposes.filter(purpose => purpose !== 'management' || first.owner_active === true)",
    after: 'purposes: first.purposes',
    symptom: 'deactivated native owner relationship still reads settings200 instead of403' },
  logout: { file: 'lib/human-session/engine.js', before: 'await tx.revoke();',
    after: '/* native durable logout omission */',
    symptom: 'copied cookie/bearer remains authorized after local logout; stored session stays active' },
  anonymous: { file: 'lib/tenant-authorization/postgres.js',
    before: "if (principal.kind === 'anonymous') {\n        if (!anonymousMayUse(permission)) return false;",
    after: "if (principal.kind === 'anonymous') {\n        return true;\n        if (!anonymousMayUse(permission)) return false;",
    symptom: 'actual native anonymous authority grants create instead of false; independent DATA write floor may still refuse' }
});

// Offline mutations affect only instrument admission/completion/restoration
// oracles in a VM under runtime denial. They are not native measurements.
const offline = Object.freeze({
  completion: { before: 'keys.some(key => result[key] !== true)', after: 'false',
    symptom: 'missing owner family no longer causes OWNER_BROWSER_FAMILY_INCOMPLETE' },
  admission: { before: "plan.env.HUMAN_SESSION_NATIVE_RESERVED !== '1' ||", after: 'false ||',
    symptom: 'missing native reservation no longer refuses before any acquired context' },
  restoration: { before: 'try { await restore(); } catch (error) {', after: 'try { /* omitted restoration */ } catch (error) {',
    symptom: 'temporary native-state restoration callback is absent after a refused operation' },
  cookieDelete: { before: "...(unsafe ? { origin, 'x-ns-csrf': csrf } : {})", after: '...{}',
    symptom: 'bodyless cookie DELETE loses required Origin/CSRF and cannot exercise native revocation' }
});

function materialize (definition, source) {
  if (!definition || typeof source !== 'string' || source.split(definition.before).length !== 2) {
    throw new Error('OWNER_BROWSER_CONTROL_ANCHOR_MISMATCH');
  }
  const mutated = source.replace(definition.before, definition.after);
  const hash = value => createHash('sha256').update(value).digest('hex');
  return { source: mutated, originalSha256: hash(source), mutantSha256: hash(mutated),
    symptom: definition.symptom, execution: 'NOTEXECUTED' };
}

module.exports = { native, offline, materialize };
