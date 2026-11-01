#!/usr/bin/env node
'use strict';

// Research prototype (proto/views-nonresident): one tenant, nonresident.
// API v3, the authorization endpoints and GET /api/v2/properties, with alarms
// computed from bounded queries (lib/data/views) on each write and on the
// heartbeat tick, and no resident ddata. Not a way to run a site.
//
//   NIGHTSCOUT_EXECUTION=nonresident node scripts/views-profile-server.js
//
// NIGHTSCOUT_EXECUTION=nonresident is the opt-in; without it this script
// refuses (exit 64). Nothing else reads that setting: `nightscout single`
// stays resident whatever it is set to. Listens where the api role does
// (API_PORT, API_HOSTNAME, then PORT and HOSTNAME).

const LABEL = 'views profile (research prototype)';
const OPT_IN = 'NIGHTSCOUT_EXECUTION';

if (require.main === module) {
  if (process.argv.length > 2 || process.env[OPT_IN] !== 'nonresident') {
    process.stderr.write('Usage: ' + OPT_IN + '=nonresident node scripts/views-profile-server.js (no arguments)\n');
    process.exit(64);
  }
  console.log(LABEL + ': single-tenant, nonresident; not for running a site');
  require('../lib/server/runtime-policy')();
  const env = require('../lib/server/env')();
  const language = require('../lib/language')();
  language.set(env.settings.language);
  language.loadLocalization(require('fs'));
  const listeners = require('../lib/server/serve/listeners');
  const views = require('../lib/server/serve/views');
  let spec;
  try {
    spec = listeners.resolve(['api'], process.env, { host: env.HOSTNAME, port: env.PORT })[0];
  } catch (err) {
    process.stderr.write(LABEL + ': ' + err.message + '\n');
    process.exit(78);
  }
  views.boot(env, language).then(async ctx => {
    const { app } = views.createApp(env, ctx);
    const server = await listeners.open(spec, app, env.ssl);
    const address = server.address();
    console.log(LABEL + ': listening on', address.address + ':' + address.port);
    function shutdown () {
      listeners.close(server).then(() => views.stop(ctx)).then(() => { process.exitCode = 0; });
    }
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }, err => {
    process.stderr.write(LABEL + ': could not start: ' + (err && err.message) + '\n');
    process.exit(1);
  });
}
