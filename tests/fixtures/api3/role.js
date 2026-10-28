'use strict';

// The role the API v3 suites boot their instances as (see instance.js).
// API3_TEST_TARGET unset is `single`, the full chain; `serve-api` is
// `nightscout serve api` (lib/server/serve/api.js). Any other value is
// refused, so a typo cannot quietly run the suites as `single`.

const ROLES = ['single', 'serve-api'];

function current () {
  const target = process.env.API3_TEST_TARGET;
  if (target === undefined || target === '') return 'single';
  if (ROLES.includes(target)) return target;
  throw new Error(`API3_TEST_TARGET=${target} is not a role the API v3 suites know (${ROLES.join(', ')})`);
}

// Tests that apply to one role only: their subject is something the other
// role does not have (API v1 modules, the cache, the websocket). In the other
// role they are pending, with the role and the reason in the title, so the
// spec reporter lists them and counts them as pending:
//
//   onlyIn('single', 'subject is the websocket').describe('...', fn)
//   onlyIn('single', 'subject is the cache').it('...', fn)

function onlyIn (role, reason) {
  if (!ROLES.includes(role)) {
    throw new Error(`onlyIn: unknown role ${role} (${ROLES.join(', ')})`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('onlyIn: a reason is required');
  }
  const runs = current() === role;
  const tag = `[${role} only: ${reason}]`;

  function wrap (run, skip) {
    return function (title, fn) {
      if (runs) return run(title, fn);
      return skip(`${title} ${tag}`, fn);
    };
  }

  return {
    describe: wrap((t, fn) => describe(t, fn), (t, fn) => describe.skip(t, fn))
    , it: wrap((t, fn) => it(t, fn), (t, fn) => it.skip(t, fn))
  };
}

module.exports = { ROLES, current, onlyIn };
