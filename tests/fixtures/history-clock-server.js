'use strict';

// Each fork has a fresh module cache, as a real application restart does.
// Holding wall time fixed makes a fast import's clock lead deterministic on CI.
if (process.env.HISTORY_TEST_NOW) {
  const now = Number(process.env.HISTORY_TEST_NOW);
  Date.now = () => now;
}

require('./api3/instance').create({ useHttps: false, disableSecurity: true }).then(function (instance) {
  instance.app.use('/api/v1', require('../../lib/api')(instance.env, instance.ctx));
  process.send({ url: instance.baseUrl });
}, function (error) {
  process.send({ error: String(error) });
  process.exit(1);
});
