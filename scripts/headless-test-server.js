#!/usr/bin/env node
'use strict';

// The headless test server: API v3 and the /api/v2/authorization endpoints
// with no web pages, websocket, API v1/v2, alarms, plugins or in-memory data,
// for tests and development. It is bootevent's api profile, the code the
// multitenant api role will be built from (PLAT-SERVE, ST-V3-DECOUPLE), run
// single-tenant: API_SECRET and the rest of the process environment, MongoDB.
// It is not a way to run a site and is not in the image; a site runs
// `nightscout single`. `nightscout serve api` refuses until the api role is
// multitenant.
//
//   node scripts/headless-test-server.js        (or npm run headless-test-server)
//
// It listens where the api role does (API_PORT, API_HOSTNAME, falling back to
// PORT and NIGHTSCOUT_HOSTNAME / HOSTNAME; lib/server/serve/listeners.js), exits
// 78 for listener settings it cannot use and 1 if it cannot start, and stops on
// SIGTERM or SIGINT with exit 0. `nightscout healthcheck --role api` probes it.

const LABEL = 'headless test server';

if (require.main === module) {
  if (process.argv.length > 2) {
    process.stderr.write('Usage: node scripts/headless-test-server.js (no arguments)\n');
    process.exit(64);
  }
  console.log(LABEL + ': single-tenant API v3 for tests and development; not for running a site');
  const io = { stdout: process.stdout, stderr: process.stderr, env: process.env };
  Promise.resolve(require('../lib/cli/commands/serve').runRoles(['api'], io, LABEL)).then(code => {
    if (code !== undefined) process.exitCode = code;
  });
}
