'use strict';

// Used by tests/nightscout-cli.test.js: a script run through the dispatcher.
process.stdout.write(process.argv.slice(2).join(' '));
