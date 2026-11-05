'use strict';

// `nightscout multitenant <role>[,<role>...]` is PLAT-SERVE (D21, D5, D16): run the
// multitenant roles named, each on its own listener (lib/server/serve/).
//
//   exit 64 (EX_USAGE)   no role list, an unknown role, a role named twice, or
//                        a role that cannot be served yet ("not yet available")
//   exit 78 (EX_CONFIG)  listener settings that would share a listener or put
//                        an internal-plane role on the consumer's address
//   exit 1               start-up failed (a listener could not be opened)
//
// SIGTERM and SIGINT close listeners and the selected runtime's storage; the process
// then exits 0 by running out of work. If anything is still holding it open
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
  let env, language, preview;

  if (multitenant) {
    try { preview = load(io.env); } catch (error) {
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

  return serve.start(names, env, language, io.env, { preview }).then(running => {
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
