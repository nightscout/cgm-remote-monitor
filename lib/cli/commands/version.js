'use strict';

// `nightscout version`: the package version, without loading the server.

function run (args, io) {
  io.stdout.write(require('../../../package.json').version + '\n');
  return 0;
}

module.exports = { run };
