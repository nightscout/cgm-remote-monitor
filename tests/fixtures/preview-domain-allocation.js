'use strict';
// Real constructors over recording SQL; no database, listener or credentials.
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const scope = require('../../lib/storage/tenant-scope');
const environment = require('../../lib/server/tenant-app/environment');
const names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
function implementation (file = require.resolve('../../lib/server/serve/preview-domains'), mutate = s => s, source) {
  const local = createRequire(file), out = { exports: {} };
  const counts = { apps: 0, collections: 0, mapped: 0 };
  const imports = name => {
    if (name === 'express') return Object.assign((...args) => { counts.apps++; return local(name)(...args); }, local(name));
    if (name === '../../api3/generic/collection') return function (options) {
      counts.collections++;
      const col = new (local(name))(options), map = col.mapRoutes;
      col.mapRoutes = () => { counts.mapped++; return map(); };
      return col;
    };
    return local(name);
  };
  vm.runInThisContext('(function(require,module,exports){' + mutate(source === undefined ? fs.readFileSync(file, 'utf8') : source) + '\n})', { filename: file })(imports, out, out.exports);
  return { create: out.exports, counts };
}
async function fixture ({ configured = 2, legacy = true, file, mutate, source, onQuery } = {}) {
  const impl = implementation(file, mutate, source), tenants = Array.from({ length: configured }, (_, i) =>
    '11111111-1111-4111-8111-' + String(i + 1).padStart(12, '0'));
  const queries = [];
  const config = { domains: names, legacyEnabled: legacy, contextEnabled: true,
    bindings: new Map(tenants.map(t => [t, {}])), environments: new Map(tenants.map((t, i) =>
      [t, environment({ settings: { units: i % 2 ? 'mmol' : 'mg/dl' } })])),
    namespaces: Object.fromEntries(names.map(n => [n, 'synthetic_' + n])) };
  const graph = await impl.create({ config, connection: {
    withTenant: (t, fn) => scope.withTenant(t, fn), transaction: fn => fn(), withSavepoint: fn => fn(),
    async query (sql) {
      queries.push({ tenant: scope.currentTenant(), sql });
      if (onQuery) { const result = await onQuery(sql, scope.currentTenant()); if (result) return result; }
      return { rows: sql.includes("current_setting('server_version')") ? [{ version: 'recording-protocol' }] : [] };
    }
  }, exchange: async () => null, deferInitialization: true });
  // Exercise the actual dispatcher without HTTP/server/socket objects. TRACE
  // maps the addressed Collection but reaches no clinical/auth handler.
  function select (tenant, logical = 'entries') {
    return new Promise((resolve, reject) => graph.data({ tenantContext: { tenant }, method: 'TRACE',
      url: '/' + logical, path: '/' + logical, headers: {} }, {}, error => error ? reject(error) : resolve()));
  }
  return { graph, tenants, counts: impl.counts, queries, select };
}
module.exports = { fixture, names };
