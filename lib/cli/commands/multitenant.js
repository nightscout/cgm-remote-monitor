'use strict';

// `nightscout multitenant <role>[,<role>...]` is PLAT-SERVE (D21, D5, D16): run the
// selected roles, with separate HTTP listeners where declared (lib/server/serve/).
//
//   exit 64 (EX_USAGE)   no role list, an unknown role, a role named twice, or
//                        a role that cannot be served yet ("not yet available")
//   exit 78 (EX_CONFIG)  listener settings that would share a listener or put
//                        an internal-plane role on the consumer's address, or
//                        serve.internal settings that are refused, or a role
//                        configuration that lists tenants without
//                        MULTITENANT_STATIC_TENANTS=lab (lib/server/serve/static-tenants.js)
//                        (lib/server/internal-api/listener-config.js)
//   exit 1               start-up failed (a listener could not be opened)
//
// SIGTERM and SIGINT close listeners and the selected runtime's storage; the process
// then exits 0 by running out of work. serve.internal closes first: in-flight
// internal calls answer for up to NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS, which
// must stay below SHUTDOWN_BOUND_MS. If anything is still holding it open
// after SHUTDOWN_BOUND_MS it exits 1 and names what was left.

const EX_USAGE = 64;
const EX_CONFIG = 78;
const SHUTDOWN_BOUND_MS = 10000;

function run (args, io) {
  const serve = require('../../server/serve');
  let names;
  try {
    names = serve.parseRoles(args);
  } catch (err) {
    if (!(err instanceof serve.RoleError)) throw err;
    io.stderr.write('nightscout multitenant: ' + err.message + '\n');
    return EX_USAGE;
  }
  require('../../server/runtime-policy')();
  return runRoles(names, io, 'nightscout multitenant', true);
}

// Boot the named roles, open their listeners and stop them on SIGTERM or
// SIGINT. Shared with scripts/headless-test-server.js, which runs the api
// role without the multitenant check.
function runRoles (names, io, label, multitenant = false) {
  const serve = require('../../server/serve');
  const { PreviewConfigError, load } = require('../../server/serve/preview-config');
  const { ListenerError, readRaw } = require('../../server/serve/listeners');
  let env, language, preview, ownerPreview, evaluatorPreview, realtimePreview, adminPreview, vcpoolPreview, operationConfig, internal, feedReader;

  if (multitenant) {
    try {
      // serve.internal belongs to the roles that call each other (api, realtime,
      // evaluator, tenant-admin) and to vcpool's inspection read. The admin role
      // serves the operator plane on its own listener (ADMIN_HOSTNAME/ADMIN_PORT)
      // and has no serve.internal.
      const listenerConfig = require('../../server/internal-api/listener-config');
      const internalNames = names.filter(name => listenerConfig.ROLES.includes(name));
      if (internalNames.length) internal = listenerConfig.resolve(internalNames, io.env);
      if (internal && internal.shutdownTimeoutMs >= SHUTDOWN_BOUND_MS) {
        throw new Error('serve.internal: NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS must be below the ' + SHUTDOWN_BOUND_MS + ' ms shutdown bound');
      }
      operationConfig = require('../../server/serve/operation-cohort-config').load(io.env, internal);
      if (names.includes('api')) preview = load(io.env);
      if (names.includes('realtime')) realtimePreview = require('../../server/realtime/config').load(io.env, internal);
      if (names.includes('evaluator')) evaluatorPreview = require('../../server/serve/evaluator-config').load(io.env, internal);
      if (names.includes('tenant-admin')) ownerPreview = require('../../server/serve/owner-preview-config').load(io.env);
      if (names.includes('admin')) adminPreview = require('../../server/serve/admin-config').load(io.env);
      if (names.includes('feed-reader')) feedReader = require('../../change-feed/config').load(io.env);
      if (names.includes('vcpool')) vcpoolPreview = require('../../tenant-connector/config').load(io.env);
      // A tenant list in a role configuration is a lab input only (MULTITENANT_STATIC_TENANTS=lab).
      const notice = require('../../server/serve/static-tenants').check(io.env, { preview, realtimePreview, evaluatorPreview, ownerPreview, adminPreview, vcpoolPreview, operationConfig });
      if (notice) console.warn(label + ': ' + notice);
    } catch (error) {
      io.stderr.write(label + ': ' + error.message + '\n');
      return EX_CONFIG;
    }
    // No single-tenant secrets, Mongo boot, localization or process env mutation.
    env = { HOSTNAME: readRaw(io.env, 'HOSTNAME') || '127.0.0.1', PORT: readRaw(io.env, 'PORT') || 1337 };
  } else {
    // Preserve the single-tenant headless profile.
    require('../../server/runtime-policy')();
    env = require('../../server/env')();
    language = require('../../language')();
    language.set(env.settings.language);
    language.loadLocalization(require('fs'));
  }

  return serve.start(names, env, language, io.env, { preview, ownerPreview, evaluatorPreview, realtimePreview, adminPreview, vcpoolPreview, operationConfig, internal, feedReader }).then(running => {
    let stopping = false;
    function shutdown (signal) {
      if (stopping) return;
      stopping = true;
      console.log(label + ': ' + signal + ', closing listeners and storage');
      const watchdog = setTimeout(() => {
        const left = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
        console.error(label + ': still open ' + SHUTDOWN_BOUND_MS + ' ms after ' + signal + ': ' + left.join(', '));
        process.exit(1);
      }, SHUTDOWN_BOUND_MS);
      watchdog.unref();
      running.stop().then(() => {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
        process.exitCode = 0;
      }, err => {
        console.error(label + ': shutdown failed: ' + (err && err.message));
        process.exit(1);
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    if (names.includes('feed-reader')) io.stdout.write(label + ': feed-reader started\n');
    return undefined;
  }, err => {
    if (err instanceof ListenerError || err instanceof PreviewConfigError) {
      io.stderr.write(label + ': ' + err.message + '\n');
      return EX_CONFIG;
    }
    io.stderr.write(label + ': could not start: ' +
      (multitenant ? 'preview startup failed' : (err && err.message ? err.message : err)) + '\n');
    return 1;
  });
}

module.exports = { run, runRoles, SHUTDOWN_BOUND_MS };
