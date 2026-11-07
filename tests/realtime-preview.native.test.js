'use strict';
const path = require('node:path');
const { optInSuite } = require('./support/opt-in');
optInSuite(process.env.NS_RT_EARLY_NATIVE === '1' && !!process.env.NS_RT_NATIVE_PHASE && !!process.env.NS_RT_NATIVE_CAPTURE,
  'NS_RT_EARLY_NATIVE=1 with root-owned phase/resources/capture')('actual realtime early native uncertainty', function () {
  this.timeout(60000);
  it('executes the explicitly selected owned phase', async function () {
    await require('./fixtures/realtime-preview/early').execute({ sourceDir: path.resolve(__dirname, '..'),
      captureDir: process.env.NS_RT_NATIVE_CAPTURE, phaseId: process.env.NS_RT_NATIVE_PHASE, control: null, env: process.env });
  });
});
