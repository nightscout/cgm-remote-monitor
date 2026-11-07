'use strict';
// Explicit fixture-only Node preload. Calls original boot with identical options;
// samples only real returned getters. No result/config/auth/provider mutation.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const digest = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function options (env) {
  const value = { file: env.NS_RT_EVALUATOR_OBSERVATION_FILE, intervalMs: Number(env.NS_RT_EVALUATOR_OBSERVATION_INTERVAL_MS),
    maxBytes: Number(env.NS_RT_EVALUATOR_OBSERVATION_MAX_BYTES), sourceHead: env.NS_RT_SOURCE_HEAD, phaseId: env.NS_RT_NATIVE_PHASE };
  assert(typeof value.file === 'string' && path.isAbsolute(value.file), 'EVALUATOR_OBSERVER_FILE_REQUIRED');
  assert(Number.isSafeInteger(value.intervalMs) && value.intervalMs > 0 && value.intervalMs <= 2147483647, 'EVALUATOR_OBSERVER_INTERVAL_REQUIRED');
  assert(Number.isSafeInteger(value.maxBytes) && value.maxBytes > 0, 'EVALUATOR_OBSERVER_BOUND_REQUIRED');
  assert.match(value.sourceHead, /^[a-f0-9]{40}$/); assert.match(value.phaseId, /^[a-z0-9][a-z0-9_-]{0,95}$/);
  return value;
}
function writer (config) {
  const directory = fs.lstatSync(path.dirname(config.file));
  assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() && (directory.mode & 0o077) === 0,
    'EVALUATOR_OBSERVER_OWNED_PRIVATE_DIRECTORY_REQUIRED');
  return snapshot => {
    const bytes = Buffer.from(JSON.stringify(snapshot)); assert(bytes.length <= config.maxBytes, 'EVALUATOR_OBSERVER_FILE_BOUND');
    let descriptor;
    try {
      try { descriptor = fs.openSync(config.file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        descriptor = fs.openSync(config.file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(descriptor);
        assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.size <= config.maxBytes, 'EVALUATOR_OBSERVER_FOREIGN_FILE');
        const prior = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
        assert(prior.phaseId === config.phaseId && prior.sourceHead === config.sourceHead, 'EVALUATOR_OBSERVER_FOREIGN_LINEAGE');
      }
      fs.writeSync(descriptor, bytes, 0, bytes.length, 0); fs.ftruncateSync(descriptor, bytes.length);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  };
}
function wrapBoot (original, config, write = writer(config)) {
  const preload = { path: __filename, sha256: digest(__filename) };
  const bootFile = path.resolve(__dirname, '../../../lib/server/serve/evaluator-preview.js');
  const product = { path: bootFile, sha256: digest(bootFile) };
  return async function observedBoot (selected) {
    const actual = await original(selected); let timer, closing, sequence = 0;
    function sample () {
      const observed = actual.health();
      const health = { closed: observed.closed, tenants: observed.tenants.map(row => ({ tenant: row.tenant, ready: row.ready,
        code: row.code, identity: row.identity, outputRevision: row.outputRevision, inputCheckpoint: row.inputCheckpoint })) };
      const last = [...selected.tenants.keys()].map(tenant => {
        const value = actual.last(tenant);
        return { tenant, value: value === null ? null : { identity: value.identity, runtimeId: value.runtimeId, outputRevision: value.outputRevision,
          inputCheckpoint: value.inputCheckpoint, eligible: value.eligible, trigger: value.trigger } };
      });
      write({ version: 1, classification: 'actual CLI with disclosed observational getter preload', pid: process.pid,
        sourceHead: config.sourceHead, phaseId: config.phaseId, preload, product, observedAt: Date.now(), sequence: ++sequence, health, last });
    }
    try { sample(); } catch (error) { await actual.close(); throw error; }
    timer = setInterval(() => { try { sample(); } catch (error) { clearInterval(timer); console.error('EVALUATOR_OBSERVER_REFUSED', error.code || error.message); } }, config.intervalMs);
    timer.unref();
    // Copy forwarding capability; never Proxy a frozen original or alter it.
    return Object.freeze({ ...actual, close () {
      if (closing) return closing; clearInterval(timer);
      closing = (async () => { try { await actual.close(); } finally { sample(); } })(); return closing;
    } });
  };
}
module.exports = { options, writer, wrapBoot };
if (process.env.NS_RT_EVALUATOR_OBSERVE === '1') {
  const product = require('../../../lib/server/serve/evaluator-preview'), original = product.boot;
  product.boot = wrapBoot(original, options(process.env));
}
