'use strict';

// Test helpers for the views profile (research prototype,
// proto/views-nonresident).
//
// resident(): today's resident path on the same database, built the way
// bootevent builds single's (a ddata, a cache, the data loader, a plugin set
// and a notification service of its own; the 'data-loaded' cycle), for one
// evaluation at `now`. The comparison arm for the profile.
//
// viewsContext(): the break-it controls, as a wrapper on the context the
// profile's views read through (lib/server/nonresident.js opts.viewsCtx).
//   VIEWS_PROFILE_DS_NEWEST=<n>   device status: keep only the n newest of
//                                 the view's answer (control c)
//   VIEWS_SHRINK, VIEWS_TAMPER    the equality harness's own controls
//                                 (tests/lib/views-equality/views.js)

const { EventEmitter } = require('events');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const createDData = require(path.join(ROOT, 'lib/data/ddata'));
const createCache = require(path.join(ROOT, 'lib/server/cache'));
const createLoader = require(path.join(ROOT, 'lib/data/dataloader'));
const createNotifications = require(path.join(ROOT, 'lib/notifications'));
const sandbox = require(path.join(ROOT, 'lib/sandbox'));
const productViews = require(path.join(ROOT, 'lib/data/views'));
const harness = require(path.join(ROOT, 'tests/lib/views-equality/views'));

function plugins (env, ctx) {
  return require(path.join(ROOT, 'lib/plugins'))({
    settings: env.settings, webhook: env.webhook, language: ctx.language, levels: ctx.levels, moment: ctx.moment
  }).registerServerDefaults();
}

// A resident path with state that persists between evaluations, as single's.
function createResident (env, ctx) {
  const rctx = Object.create(ctx);
  rctx.bus = new EventEmitter();
  rctx.bus.setMaxListeners(0);
  rctx.ddata = createDData();
  rctx.cache = createCache(env, rctx);
  rctx.dataloader = createLoader(env, rctx);
  rctx.plugins = plugins(env, ctx);
  rctx.notifications = createNotifications(env, rctx);
  rctx.runtimeState = 'loaded';
  const out = { emitted: [], requested: [] };
  rctx.bus.on('notification', n => out.emitted.push(n));
  const rn = rctx.notifications.requestNotify;
  const rs = rctx.notifications.requestSnooze;
  rctx.notifications.requestNotify = function (n) { const r = rn(n); out.requested.push(Object.assign({ kind: 'notify' }, n)); return r; };
  rctx.notifications.requestSnooze = function (s) { const r = rs(s); out.requested.push(Object.assign({ kind: 'snooze' }, s)); return r; };

  // one 'data-loaded' cycle after a load; resolves with what it emitted and requested
  function evaluate () {
    out.emitted = [];
    out.requested = [];
    return new Promise(resolve => rctx.dataloader.update(rctx.ddata, () => resolve())).then(function () {
      const sbx = sandbox().serverInit(env, rctx);
      rctx.plugins.setProperties(sbx);
      rctx.notifications.initRequests();
      rctx.plugins.checkNotifications(sbx);
      rctx.notifications.process(sbx);
      rctx.sbx = sbx;
      return { emitted: out.emitted, requested: out.requested, properties: sbx.properties };
    });
  }
  return { ctx: rctx, evaluate };
}

function newestOnly (n) {
  return function keep (docs) {
    return docs.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, n);
  };
}

// The context the profile's views read through, with the controls set in
// the environment applied (none: ctx itself).
function viewsContext (ctx, tamperView) {
  let vctx = ctx;
  const shrink = process.env.VIEWS_SHRINK;
  const tamper = tamperView ? harness.TAMPER[tamperView] : null;
  if (shrink || tamper) vctx = harness.productContext(vctx, tamper, null, false);
  const n = Number(process.env.VIEWS_PROFILE_DS_NEWEST);
  if (n > 0) {
    const real = vctx.devicestatus;
    const keep = newestOnly(n);
    vctx = Object.create(vctx);
    vctx.devicestatus = {
      list (q, cb) {
        real.list(q, function (err, docs) {
          if (!err && docs && productViews.kindOf('devicestatus', q) === 'devicestatus') docs = keep(docs);
          cb(err, docs);
        });
      }
    };
  }
  return vctx === ctx ? undefined : vctx;
}

// harness.sig, with the group a notification service fills in (requestNotify
// sets `default` on the request it is handed, after or before a recorder
// copies it)
function sig (list) {
  return harness.sig(list.map(n => Object.assign({}, n, { group: n.group || 'default' })));
}

module.exports = { createResident, viewsContext, sig, plugins };
