'use strict';
// Admin restore integration fixture: exact external operator/plan bytes with
// this test tree's product dependencies. No deployment HEAD or vendored fallback.
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const producer = require('./pgstream-native');
const ROOT = path.resolve(__dirname, '../..');
module.exports = function canonicalAdminRestore (source = process.env) {
  // Reuse the maintained fixture's retained-file and exact git-object pins.
  producer.binding(source);
  const selected = JSON.parse(source[producer.ENV.binding]), cache = new Map(), hashes = {};
  function load (name) {
    if (!/^[a-z][a-z0-9-]*\.js$/.test(name)) throw new Error('ADMIN_RESTORE_CANONICAL_MODULE_SCOPE');
    if (cache.has(name)) return cache.get(name).exports;
    const bytes = execFileSync('git', ['-C', selected.repository, 'show', selected.commit + ':bindings/compose/multitenant/' + name],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
    const filename = path.join(ROOT, 'deploy/multitenant', name), original = createRequire(filename), module = { exports: {} };
    cache.set(name, module);
    const requireCanonical = id => id.startsWith('./') ? load(id.slice(2) + (path.extname(id) ? '' : '.js')) : original(id);
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + bytes.toString('utf8') + '\n})', { filename })(
      requireCanonical, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  const plan = load('config.js'), operator = load('restore.js');
  for (const name of ['layout', 'catalogues', 'grants', 'documents', 'lifecycle', 'quote']) {
    if (typeof plan[name] !== 'function') throw new Error('ADMIN_RESTORE_CANONICAL_PLAN_API');
  }
  for (const name of ['capture', 'restore']) if (typeof operator[name] !== 'function') throw new Error('ADMIN_RESTORE_CANONICAL_OPERATOR_API');
  if (typeof plan.A !== 'string' || typeof plan.B !== 'string') throw new Error('ADMIN_RESTORE_CANONICAL_TENANTS');
  return { plan, operator, identity: { repository: selected.repository, commit: selected.commit, hashes } };
};
