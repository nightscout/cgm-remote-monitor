'use strict';

// `nightscout serve <role>[,<role>...]` is PLAT-SERVE (D21, D5, D16): run the
// hosted roles named, each on its own listener (lib/server/serve/).
//
//   exit 64 (EX_USAGE)   no role list, an unknown role, a role named twice, or
//                        a role that cannot be served yet ("not yet available")
//   exit 78 (EX_CONFIG)  listener settings that would share a listener or put
//                        an internal-plane role on the consumer's address
//   exit 1               start-up failed (a listener could not be opened)
//
// SIGTERM and SIGINT close the listeners and the MongoDB client; the process
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
    io.stderr.write('nightscout serve: ' + err.message + '\n');
    return EX_USAGE;
  }

  // As lib/server/server.js prepares them for `single`.
  require('../../server/runtime-policy')();
  const env = require('../../server/env')();
  const language = require('../../language')();
  language.set(env.settings.language);
  language.loadLocalization(require('fs'));

  const { ListenerError } = require('../../server/serve/listeners');
  return serve.start(names, env, language, io.env).then(running => {
    let stopping = false;
    function shutdown (signal) {
      if (stopping) return;
      stopping = true;
      console.log('nightscout serve: ' + signal + ', closing listeners and storage');
      const watchdog = setTimeout(() => {
        const left = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
        console.error('nightscout serve: still open ' + SHUTDOWN_BOUND_MS + ' ms after ' + signal + ': ' + left.join(', '));
        process.exit(1);
      }, SHUTDOWN_BOUND_MS);
      watchdog.unref();
      running.stop().then(() => {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
        process.exitCode = 0;
      }, err => {
        console.error('nightscout serve: shutdown failed: ' + (err && err.message));
        process.exit(1);
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return undefined;
  }, err => {
    if (err instanceof ListenerError) {
      io.stderr.write('nightscout serve: ' + err.message + '\n');
      return EX_CONFIG;
    }
    io.stderr.write('nightscout serve: could not start: ' + (err && err.message ? err.message : err) + '\n');
    return 1;
  });
}

module.exports = { run, SHUTDOWN_BOUND_MS };
