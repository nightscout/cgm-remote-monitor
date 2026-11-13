'use strict';

// Fixture-only source contexts. No permission is inferred from a live database,
// and a failed product ACL guard never triggers a fallback or a wider grant.
const assert = require('node:assert/strict');
const common = require('../../../lib/tenant-operations/common');
const { validateAcl } = require('../../../lib/tenant-operations/restore');
const CLASSES = ['api', 'readiness', 'alarm', 'realtime', 'evaluator', 'suppression', 'outbox'];
function fingerprint (admission) {
  return admission.catalogues.map(entry => ({ kind: entry.kind, candidateDigest: common.sha256(common.canonical(entry.catalogue)), tables: entry.tables.slice() }));
}
function validateManifest (manifest, currentHead, oldHead) {
  assert.equal(manifest.versionedAclVersion, 1, 'WHOLE_C_VERSIONED_ACL_REQUIRED');
  assert.deepEqual(Object.keys(manifest.contexts).sort(), ['CURRENT', 'OLD'], 'WHOLE_C_EXACT_ACL_CONTEXTS');
  assert.deepEqual(manifest.contexts.CURRENT.grants, manifest.grants, 'WHOLE_C_CURRENT_ACL_CHANGED');
  for (const [context, head] of [['CURRENT', currentHead], ['OLD', oldHead]]) {
    const selected = manifest.contexts[context];
    assert.equal(selected.sourceHead, head, 'WHOLE_C_ACL_SOURCE_HEAD');
    assert.ok(Array.isArray(selected.catalogues) && selected.catalogues.length > 0, 'WHOLE_C_ACL_CATALOGUES');
    assert.ok(Array.isArray(selected.grants) && selected.grants.length > 0, 'WHOLE_C_ACL_GRANTS');
    assert.ok(selected.grants.every(grant => CLASSES.includes(grant.role)), 'WHOLE_C_ACL_ROLE_CLASS');
  }
}
function project (manifest, admission, context, names) {
  assert.ok(['CURRENT', 'OLD'].includes(context), 'WHOLE_C_ACL_CONTEXT_UNKNOWN');
  const selected = manifest.contexts[context];
  assert.deepEqual(fingerprint(admission), selected.catalogues, 'WHOLE_C_ACL_CATALOGUE_CHANGED');
  const grants = selected.grants.map(grant => {
    assert.ok(CLASSES.includes(grant.role) && common.ROLE.test(names[grant.role] || ''), 'WHOLE_C_ACL_ROLE_CLASS');
    return { ...grant, role: names[grant.role] };
  });
  validateAcl({ grants }, common.plan(admission.catalogues));
  return { grants, evidence: { context, sourceHead: selected.sourceHead,
    candidateSetDigest: common.sha256(common.canonical(selected.catalogues)), grantsDigest: common.sha256(common.canonical(selected.grants)) } };
}
module.exports = { fingerprint, validateManifest, project };
