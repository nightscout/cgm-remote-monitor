'use strict';

// Descriptors only. Applying or executing these native semantic mutants needs
// the lead's new complete source/instrument-bound grant. Offline tests below
// validate anchor uniqueness and instrument oracles, never native behavior.
const controls = Object.freeze([
  Object.freeze({ id: 'consumer-stale-evaluator-settings', nativeExecution: 'NOTEXECUTED',
    path: 'lib/server/serve/evaluator-runtime.js',
    before: 'state.instance.reconfigure({ env: current.env });',
    after: "if (current.env.settings.units !== 'mmol') state.instance.reconfigure({ env: current.env }); // native semantic control: preserve committed mg/dL-baseline settings after display-unit change",
    family: 'evaluatorCycle', expected: 'eligible time-only output retains threshold200 and emits zero high alarms for synthetic190; oracle requires one at threshold180' }),
  Object.freeze({ id: 'consumer-current-data-authority-bypass', nativeExecution: 'NOTEXECUTED',
    path: 'lib/server/tenant-app/data-access.js',
    before: 'if (await currentAuthority.authorize({ tenant, principal, permission }) !== true) {',
    after: 'if (false) { // native semantic control: bypass current DATA read authority',
    family: 'dataRevocation', expected: 'after native role permissions narrow to empty, existing valid subject DATA read incorrectly returns200; oracle requires401/403' })
]);

function applyToSource (source, control) {
  if (!controls.includes(control) || source.split(control.before).length !== 2) throw new Error('CONSUMER_CONTROL_SOURCE_MISMATCH');
  return source.replace(control.before, control.after);
}

module.exports = { controls, applyToSource };
