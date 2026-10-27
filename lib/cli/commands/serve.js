'use strict';

// `nightscout serve <role>[,<role>...]` is PLAT-SERVE (D21, D5, D16): the
// hosted roles api, evaluator, realtime, vcpool, tenant-admin and admin. No
// role can be served on its own yet, so this refuses with EX_USAGE rather
// than starting something an operator did not ask for.

const EX_USAGE = 64;

function run (args, io) {
  io.stderr.write('nightscout serve is not yet available. Use `nightscout single` to run the server.\n');
  return EX_USAGE;
}

module.exports = { run };
