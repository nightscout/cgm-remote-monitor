'use strict';

const healthcheck = require('../../lib/cli/commands/healthcheck');

// Probe the same private readiness endpoint as the deployed healthcheck CLI.
module.exports = async function ready ({ socketPath, url, timeoutMs }) {
  const path = '/healthz/ready';
  const address = socketPath ? undefined : new URL(path, url).href;
  const response = await healthcheck.probe(address, { socketPath, path, timeout: timeoutMs });
  return healthcheck.verdict(response, undefined, 'ready').healthy;
};
