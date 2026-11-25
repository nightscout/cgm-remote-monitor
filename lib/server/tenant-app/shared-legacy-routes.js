'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const createV1 = require('../../api');
const createV2 = require('../../api2');
const environment = require('./environment');
const tenantScope = require('../../storage/tenant-scope');
const authorization = require('./legacy-authorization');
const derivedReads = require('./derived-reads');
const derivedFrame = require('./derived-frame');
const language = require('../../language')();

// Shipping legacy factories close over their context. Adapt those closures at
// the composition boundary; never change a process-global current tenant.
// Storage wrappers and mutable clinical frames remain owned by the caller.
module.exports = function sharedLegacyRoutes ({ domains }) {
  const requests = new AsyncLocalStorage();
  const variants = new Map();
  function selected () {
    const value = requests.getStore();
    if (!value) throw new Error('Unbound shared legacy request');
    return value;
  }
  function make (careportal) {
    const template = environment({ settings: { enable: careportal ? ['careportal'] : [] } });
    let constructing = true;
    const env = new Proxy({}, {
      get: (_, key) => (constructing ? template : selected().env)[key]
    });
    const ctx = { authorization: authorization() };
    const wares = require('../../middleware')(env);
    // IncomingMessage exists before request dispatch. Its stream events can
    // arrive outside this async context; rebind parser continuations explicitly.
    const bindNext = handler => (req, res, next) => {
      const operation = selected();
      return handler(req, res, error => requests.run(operation, () => next(error)));
    };
    for (const name of ['rawParser', 'jsonParser', 'urlencodedParser']) wares[name] = bindNext(wares[name]);
    wares.bodyParser = Object.fromEntries(Object.entries(wares.bodyParser).map(([name, factory]) =>
      [name, options => bindNext(factory(options))]));
    Object.defineProperty(ctx, 'wares', { get: () => wares });
    for (const field of ['storagePorts', 'bus', 'purifier', 'ddata', 'cache', 'sbx']) {
      Object.defineProperty(ctx, field, {
        get: () => selected().ctx[field], set: value => { selected().ctx[field] = value; }
      });
    }
    // entries is captured by the shipping factory, so retain a forwarding
    // object. Other modules also see the same identity during a request.
    for (const logical of domains) {
      ctx[logical] = new Proxy({}, { get: (_, key) => {
        const target = selected().ctx[logical];
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    const v1 = createV1(env, ctx, { domains, apiEnabled: true });
    const v2 = createV2(env, ctx, v1, { compatibilityOnly: true });
    const derived = derivedReads({ env, ctx, loadFrame: options => selected().loadFrame(options) });
    v2.use(derived);
    constructing = false;
    return { v1, v2, ctx };
  }
  return {
    currentContext (tenant) {
      const value = requests.getStore();
      if (value && value.tenant !== tenant) throw new Error('Shared legacy context tenant mismatch');
      return value?.ctx;
    },
    dispatch ({ tenant, env, ctx, loadFrame }, req, res, next) {
      if (!tenant || (req.tenantContext?.tenant || tenantScope.currentTenant()) !== tenant || !environment.isSafe(env)) {
        return next(new Error('Shared legacy tenant binding refused'));
      }
      const careportal = env.settings.enable.includes('careportal');
      if (!variants.has(careportal)) variants.set(careportal, make(careportal));
      const routes = variants.get(careportal);
      return requests.run({ tenant, env, ctx, loadFrame }, () =>
        (req.baseUrl === '/api/v2' ? routes.v2 : routes.v1)(req, res, next));
    },
    prepare: (env, frame) => derivedFrame({ env, frame, language })
  };
};
