'use strict';

const environment = require('./environment');

// Dynamic configuration is restricted to presentation READs. Uploads, raw
// collection operations and credential exchange never call this dependency.
function consumesDisplay (req) {
  return ['GET', 'HEAD'].includes(req.method) && /^\/(?:status|properties|ddata|summary)(?:[/.]|$)/i.test(req.path);
}
async function forRequest ({ reader, tenant, env, request, domains }) {
  if (!reader || !consumesDisplay(request)) return env;
  if (!environment.isSafe(env) || typeof reader.read !== 'function') throw new TypeError('Explicit presentation environment required');
  const state = await reader.read(tenant);
  const local = environment({ settings: { ...env.settings,
    units: state.effective.DISPLAY_UNITS.value, showSeconds: state.effective.SHOW_SECONDS.value
  }, extendedSettings: env.extendedSettings });
  for (const logical of domains) local[logical + '_collection'] = logical;
  return local;
}
module.exports = { consumesDisplay, forRequest };
