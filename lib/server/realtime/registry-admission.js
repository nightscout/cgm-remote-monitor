'use strict';

// Socket admission served from the tenant registry (decision tenant-registry):
// the same object shape as the admission file (lib/server/realtime/admission.js)
// so the protocol, socket server, socket authority and private API use it
// unchanged.
//
//   resolve(request)   the registry resolver maps the Host to an active tenant;
//                      the tenant must also be admitted (`active`). Any refusal
//                      is SOCKET_ADMISSION_REFUSED, as with the file.
//   allows(tenant)     whether the tenant is admitted now.
//   enabled()          the admitted set (realtime's detection reads it once per pass).
//   ids, aliases       empty: the registry has no tenant-to-host reverse lookup.
//                      Realtime's warm names the tenant only (socket-authority
//                      `authorizeSocket` without `host`, registry mode).
//
// On realtime, `active` is the registry tenant set (enumerated, refreshed on the
// aggregate revision). On the api, `active` asks the registry entry for the
// tenant (a removed tenant refuses). Both fail closed.
const c = require('./contract');

function create ({ resolver, active, enabled }) {
  if (typeof resolver?.resolve !== 'function' || typeof active !== 'function') throw new TypeError('Registry admission requires a resolver and an admission predicate');
  async function allows (tenant) {
    if (!c.uuid(tenant)) return false;
    try { return await active(tenant) === true; } catch { return false; }
  }
  async function resolve (request) {
    let tenant;
    try { tenant = await resolver.resolve(request); } catch { c.fail('SOCKET_ADMISSION_REFUSED'); }
    if (!await allows(tenant)) c.fail('SOCKET_ADMISSION_REFUSED');
    return tenant;
  }
  return Object.freeze({
    registry: true,
    ids: Object.freeze([]), aliases: Object.freeze([]),
    allows, resolve,
    async enabled () {
      if (typeof enabled !== 'function') c.fail('SOCKET_ADMISSION_REFUSED');
      return new Set(await enabled());
    },
    resolveHost: host => resolve({ rawHeaders: ['Host', host], socket: {} })
  });
}

module.exports = { create };
