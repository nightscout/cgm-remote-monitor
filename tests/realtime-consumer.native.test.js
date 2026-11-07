'use strict';
const path = require('node:path');
const { optInSuite } = require('./support/opt-in');
optInSuite(process.env.NS_RT_CONSUMER_NATIVE === '1' && process.env.NS_RT_JOINED_NATIVE === '1',
  'root-frozen actual evaluator/outbox/API/RT consumer join')('actual realtime durable consumer join', function () {
  this.timeout(120000);
  it('retries uncertain same identity and consumes current durable suppression', async function () {
    await require('./fixtures/realtime-preview/consumer')({ sourceDir: path.resolve(__dirname, '..'),
      captureDir: process.env.NS_RT_NATIVE_CAPTURE, phaseId: process.env.NS_RT_NATIVE_PHASE, env: process.env });
  });
});
