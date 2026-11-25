'use strict';

// Owner pause/unpause service. The tenant is always the authenticated
// management context's tenant (resolved from the request and bound to the
// credential by the router); no request field can name another tenant.
// Owners cannot suspend: the policy refuses the verb, and the owner database
// identity has no UPDATE privilege on `suspended`.
const policy = require('./policy');
const refuse = code => Object.assign(new Error(code), { code });

function view (row) {
  return Object.freeze({ state: row.state, version: row.version,
    notice: row.state === 'suspended' ? policy.OWNER_NOTICE.suspended
      : row.state === 'paused' ? policy.OWNER_NOTICE.pause + ' ' + policy.OWNER_NOTICE.unpause : policy.OWNER_NOTICE.pause });
}

function createOwnerActivity ({ store, authorize } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.transition !== 'function' || store.capability !== 'owner' ||
      typeof authorize !== 'function') throw new TypeError('Owner activity requires an owner store and current authority');
  async function admitted (context) {
    if (!await authorize(context)) throw refuse('ACTIVITY_FORBIDDEN');
  }
  return Object.freeze({
    async read (context) {
      await admitted(context);
      const row = await store.read(context.tenant);
      if (!row) throw refuse('ACTIVITY_NOT_PROVISIONED');
      return view(row);
    },
    async transition (context, verb, expectedVersion) {
      if (!policy.VERBS.owner.includes(verb)) throw refuse('ACTIVITY_FORBIDDEN');
      await admitted(context);
      return view(await store.transition(context, verb, { expectedVersion }));
    }
  });
}

module.exports = { createOwnerActivity, view };
