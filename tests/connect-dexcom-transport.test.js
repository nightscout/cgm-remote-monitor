'use strict';

const {execFile} = require('node:child_process');
const path = require('node:path');
const {promisify} = require('node:util');
const run = promisify(execFile);

describe('Connect Dexcom transport after legacy migration', function () {
  this.timeout(30000);
  it('validates TLS, private startup, session expiry and teardown over repeated cycles', async function () {
    // The API fixture suites disable TLS verification process-wide. A separate
    // process verifies the connector's default TLS behavior without inheriting
    // that override or changing another suite's environment.
    const env = {...process.env};
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    await run(process.execPath, ['--test', path.join(__dirname, 'fixtures/connect-dexcom-transport.js')],
      {env, timeout:25000, maxBuffer:1024 * 1024});
  });
});
