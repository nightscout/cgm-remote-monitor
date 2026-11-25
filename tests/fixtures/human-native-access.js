'use strict';

// Native probes use the production config loader and nonexportable signer.
// Only the already-injectable verifier clock is supplied by this apparatus;
// no token/key/UUID/authority check is replaced and no local signer is accepted.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

module.exports = function nativeAccess ({ tenant, now, source = process.env }) {
  if (source.HUMAN_SESSION_NATIVE_RESERVED !== '1' || source.HUMAN_VAULT_RESERVED !== '1' ||
      typeof source.HUMAN_SESSION_SIGNER_CONFIG !== 'string' || !source.HUMAN_SESSION_SIGNER_CONFIG ||
      typeof now !== 'function') throw new Error('Explicit reserved native Transit profile and clock required');
  const filename = require.resolve('../../lib/human-session/access-config');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => {
    const value = original(name);
    return name === './access' ? { ...value, createHumanAccess: options => value.createHumanAccess({ ...options, now }) } : value;
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const access = loaded.exports.loadHumanAccess({ source: { ...source, OIDC_ACCESS_CONFIG: source.HUMAN_SESSION_SIGNER_CONFIG },
    mode: tenant === 'single' ? 'single' : 'multi', tenants: [tenant] });
  return { access, signing: 'configured-transit',
    acceptedKeys: access.keyBindings.map(({ kid, purpose }) => ({ kid, purpose, active: true })) };
};
