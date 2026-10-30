'use strict';

// `nightscout serve <role>[,<role>...]` (D21): boot the roles asked for and
// open one listener per role. `serve` runs only a role marked multitenant, and
// none is yet; the single-tenant api role runs through
// scripts/headless-test-server.js. The role table is lib/server/serve/roles.js
// and the listener rules lib/server/serve/listeners.js.

const listeners = require('./listeners');
const { ROLES } = require('./roles');

class RoleError extends Error {}

// A comma-separated role list, checked against the role table. Throws
// RoleError for an empty, unknown, repeated or not-yet-available role: a role
// is available to `nightscout serve` once it is multitenant.
function parseRoles (args, roles) {
  roles = roles || ROLES;
  if (args.length !== 1 || !args[0]) {
    throw new RoleError('nightscout serve takes one argument, a comma-separated role list: ' + Object.keys(roles).join(', '));
  }
  const names = args[0].split(',').map(name => name.trim());
  const seen = new Set();
  for (const name of names) {
    if (!name || !Object.prototype.hasOwnProperty.call(roles, name)) {
      throw new RoleError('unknown role: ' + (name || '(empty)') + '; the roles are ' + Object.keys(roles).join(', '));
    }
    if (seen.has(name)) throw new RoleError('role named twice: ' + name);
    seen.add(name);
  }
  const unavailable = names.filter(name => !(roles[name].start && roles[name].multitenant));
  if (unavailable.length) {
    throw new RoleError('not yet available: ' + unavailable.join(', ') + '. `nightscout serve` is for a multitenant'
      + ' Nightscout, which is not built yet. Use `nightscout single` to run the server.');
  }
  return names;
}

// Boot each role and open its listener. Resolves with { servers, contexts,
// stop }, where stop() closes the listeners and then each role's MongoDB
// client. Listener settings are checked before anything is booted.
async function start (names, env, language, source) {
  const specs = listeners.resolve(names, source, { host: env.HOSTNAME, port: env.PORT });
  const servers = [];
  const contexts = {};
  // Each role boots its own context. Roles that share a process will share
  // one context once a second role can be served; with `api` alone there is
  // nothing to share.
  async function stop () {
    await Promise.all(servers.map(listeners.close));
    for (const ctx of Object.values(contexts)) {
      if (ctx.store && ctx.store.client) await ctx.store.client.close();
    }
  }

  try {
    for (const spec of specs) {
      const role = ROLES[spec.role].start();
      const ctx = await role.boot(env, language);
      contexts[spec.role] = ctx;
      const { app } = role.createApp(env, ctx);
      const server = await listeners.open(spec, app, env.ssl);
      const address = server.address();
      console.log('Listening for role', spec.role, 'on', address.address + ':' + address.port);
      servers.push(server);
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return { servers, contexts, stop };
}

module.exports = { parseRoles, start, RoleError };
