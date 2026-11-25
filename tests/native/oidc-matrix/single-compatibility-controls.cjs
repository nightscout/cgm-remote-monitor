'use strict';

// Native descriptors only. No source below is executed by offline tests.
const controls = Object.freeze([
  Object.freeze({ id: 'single-default-off-dependency-guard', nativeExecution: 'NOTEXECUTED',
    path: 'lib/human-session/runtime.js', before: 'if (!enabled(env)) return null;',
    after: 'void env; // native control: omit single default-off dependency guard', family: 'defaultOffSingle',
    expected: 'actual runtime.single touches missing OIDC config; fixture throws SINGLE_OFF_REQUESTED_OIDC_DEPENDENCY instead of returning null' }),
  Object.freeze({ id: 'single-current-subject-resolution-bypass', nativeExecution: 'NOTEXECUTED',
    path: 'lib/authorization/index.js', before: 'if (!resolved || !resolved.subject) {',
    after: 'if (false) { // native control: accept deleted subject JWT with default readable permissions', family: 'singleLegacyCompatibility',
    expected: 'deleted subject JWT remains cryptographically valid and incorrectly reads200 via default readable permissions; known-route oracle requires401/403' }),
  Object.freeze({ id: 'single-shipping-eight-hour-exchange', nativeExecution: 'NOTEXECUTED',
    path: 'lib/server/enclave.js', before: "const lt = lifetime ? lifetime : '8h';", after: "const lt = lifetime ? lifetime : '1h';",
    family: 'singleLegacyCompatibility', expected: 'actual exchange exp-iat is3600; independent oracle requires28800' })
]);
function applyToSource (source, control) {
  if (!controls.includes(control) || source.split(control.before).length !== 2) throw new Error('SINGLE_CONTROL_SOURCE_MISMATCH');
  return source.replace(control.before, control.after);
}
module.exports = { controls, applyToSource };
