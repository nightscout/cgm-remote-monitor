'use strict';

// Single-tenant, nonresident execution (research prototype on
// proto/views-nonresident; not for any release).
//
// Two axes: tenancy (one tenant or many) and execution (resident ddata, or
// views computed from bounded queries). `single` is one tenant, resident;
// this is one tenant, nonresident: bootevent's `views` profile, started by
// scripts/views-profile-server.js. It holds no ctx.ddata data, cache, data
// loader or sbx. The evaluator below is triggered by events inside the one
// process and computes the views of lib/data/views.

const ddataFactory = require('../data/ddata');

// What the v1 storage modules take from ctx.ddata when they write: the pure
// helper that derives `mills` (and `endmills`) for the data-update event.
// Every other read throws, so a resident read cannot pass for an empty one.
const HELPERS = ['processRawDataForRuntime'];

function ddataHelpersOnly () {
  const real = ddataFactory();
  const helpers = {};
  HELPERS.forEach(function bind (name) { helpers[name] = real[name]; });
  return new Proxy(helpers, {
    get (target, key) {
      if (typeof key === 'symbol' || key === 'inspect' || key === 'toJSON' || key === 'then') return target[key];
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      throw new Error('views profile: no resident ddata (read of ctx.ddata.' + String(key) + ')');
    }
    , set (target, key) {
      throw new Error('views profile: no resident ddata (write of ctx.ddata.' + String(key) + ')');
    }
  });
}

// The evaluator: nothing is triggered yet (step 1 boots the profile only).
function init () {
  const stats = { evaluations: 0 };
  return { stats };
}

init.ddataHelpersOnly = ddataHelpersOnly;
init.HELPERS = HELPERS;
module.exports = init;
