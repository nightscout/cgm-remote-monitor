'use strict';

const environment = require('./environment');

// Dynamic configuration is restricted to presentation READs. Uploads, raw
// collection operations and credential exchange never call this dependency.
function consumesDisplay (req) {
  return ['GET', 'HEAD'].includes(req.method) && /^\/(?:status|properties|ddata|summary)(?:[/.]|$)/i.test(req.path);
}
async function forRequest ({ reader, tenant, env, request, domains, metadataState }) {
  if (!reader || !consumesDisplay(request)) return env;
  if (!environment.isSafe(env) || typeof reader.read !== 'function') throw new TypeError('Explicit presentation environment required');
  const state = await reader.read(tenant);
  const projected = require('../../tenant-settings/catalogue').project(state.effective);
  // Only metadata reuses an immutable configuration context. The reader and
  // authentication still run afresh; derived computations get a private env.
  const key = metadataState && JSON.stringify([domains, projected]);
  if (metadataState && metadataState.reader === reader && metadataState.base === env && metadataState.key === key) return metadataState.env;
  const local = environment({ settings: { ...env.settings, ...projected }, extendedSettings: env.extendedSettings });
  for (const logical of domains) local[logical + '_collection'] = logical;
  if (metadataState) Object.assign(metadataState, { reader, base: env, key, env: local });
  return local;
}
module.exports = { consumesDisplay, forRequest };
