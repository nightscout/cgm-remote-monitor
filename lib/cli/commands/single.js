'use strict';

// `nightscout single`: today's server, in this process. lib/server/server.js
// stays the implementation, so this is the same app that `npm start`,
// Procfile, server.js, web.config and start.sh start; requiring it (rather
// than spawning it) lets SIGTERM reach the server directly.

const EX_USAGE = 64;

function run (args, io) {
  if (args.length) {
    io.stderr.write('nightscout single takes no arguments; configure it with environment variables\n');
    return EX_USAGE;
  }
  require('../../server/server');
}

module.exports = { run };
