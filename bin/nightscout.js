#!/usr/bin/env node
'use strict';

// The Nightscout executable (D21): one entry point that dispatches
// subcommands. `nightscout single` is today's server; every other way of
// starting it (Procfile, npm start, server.js, web.config, start.sh) is
// unchanged. See lib/cli/index.js for the subcommand table.

require('../lib/cli').main(process.argv.slice(2));
