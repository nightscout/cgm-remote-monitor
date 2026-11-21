'use strict';
// Fixture-only startup discriminator: the CLI intentionally emits a generic
// refusal. Print only an internal code or bounded source-owned error message.
const serve = require('../../lib/server/serve'), start = serve.start;
serve.start = async function (...args) {
  try { return await start.apply(this, args); }
  catch (error) { process.stderr.write('SHARD_NATIVE_STARTUP ' + String(error.code || error.message).replace(/\b[a-z]+:\/\/\S+/gi, '[endpoint]').slice(0, 160) + '\n'); throw error; }
};
