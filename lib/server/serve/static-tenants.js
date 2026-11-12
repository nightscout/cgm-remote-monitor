'use strict';

// Static mode (a tenant list in a role configuration) is a lab and test input
// only (decision tenant-registry; maintainer 2026-11-12, option 2 then 1):
// `nightscout multitenant <roles>` refuses to serve any role whose configuration
// lists tenants unless MULTITENANT_STATIC_TENANTS=lab, and logs once at start
// when the flag lets a list through. Registry mode (`registry` in the role
// configuration) needs no flag. Fixtures move to provisioning one at a time
// (MT-STATIC-MODE-RETIRE); then static mode is removed.
//
// Static lists, by role:
//   api            preview `tenants`               (no `registry`)
//   realtime       `tenants` and its admission file (no `registry`)
//   evaluator      `tenants`                       (no `registry`)
//   tenant-admin   `tenants`                       (no `registry`)
//   admin          ownership `tenants`             (provisioning and pools carry no list)
//   operation      the cohort's `locks`            (no `registry`)
//   vcpool         connector `tenants`             (no registry mode yet)
const ENV = 'MULTITENANT_STATIC_TENANTS';
const LAB = 'lab';

class StaticTenantsError extends Error {
  constructor (message) { super(message); this.code = 'STATIC_TENANTS_REFUSED'; }
}

// Which loaded configurations carry a static tenant list.
function staticRoles ({ preview, realtimePreview, evaluatorPreview, ownerPreview, adminPreview, vcpoolPreview, operationConfig } = {}) {
  const roles = [];
  if (preview && !preview.registry) roles.push('api');
  if (realtimePreview && !realtimePreview.registry) roles.push('realtime');
  if (evaluatorPreview && !evaluatorPreview.registry) roles.push('evaluator');
  if (ownerPreview && !ownerPreview.registry) roles.push('tenant-admin');
  if (adminPreview?.ownership && !adminPreview.ownership.registry) roles.push('admin');
  if (operationConfig && operationConfig.locks) roles.push('operation cohort');
  if (vcpoolPreview) roles.push('vcpool');
  return roles;
}

// Throws StaticTenantsError when a static list is present without the lab
// flag (or the flag has another value); returns the notice to log, or null.
function check (source, configs) {
  const raw = source?.[ENV];
  if (raw !== undefined && raw !== '' && raw !== LAB) throw new StaticTenantsError(ENV + ' accepts only "' + LAB + '"');
  const roles = staticRoles(configs);
  if (!roles.length) return null;
  if (raw !== LAB) {
    throw new StaticTenantsError('STATIC_TENANTS_REFUSED: ' + roles.join(', ') + ' configuration lists tenants; use the tenant registry ' +
      '(`registry` in the role configuration, tenants provisioned with `nightscout admin provision`), or set ' + ENV + '=' + LAB + ' for a lab or test');
  }
  return 'Static tenant lists in use (' + ENV + '=' + LAB + ', lab and test only): ' + roles.join(', ');
}

module.exports = { ENV, LAB, StaticTenantsError, staticRoles, check };
