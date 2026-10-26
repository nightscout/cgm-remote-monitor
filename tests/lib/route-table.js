'use strict';

// Reads the route table of an express 5 app built while `capture` is active.
//
// Express 5 (router 2.x) keeps a route's own path on `layer.route.path`, but
// does not keep the path a router or a sub-app was mounted at, nor a link from
// the `mounted_app` wrapper to the sub-app. `capture` records both on each new
// layer while the app is built, so `routes` can walk the whole tree.

const express = require('express');
const Router = require('router');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function firstNonArray (arg) {
  while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
  return arg;
}

function capture (build) {
  const routerUse = Router.prototype.use;
  const appUse = express.application.use;

  Router.prototype.use = function use (handler) {
    const path = typeof firstNonArray(handler) === 'function' ? '/' : handler;
    const before = this.stack.length;
    const result = routerUse.apply(this, arguments);
    for (const layer of this.stack.slice(before)) layer.mountPath = path;
    return result;
  };

  express.application.use = function use (fn) {
    const offset = typeof firstNonArray(fn) === 'function' ? 0 : 1;
    const fns = Array.prototype.slice.call(arguments, offset).flat(Infinity);
    const stack = this.router.stack;
    const before = stack.length;
    const result = appUse.apply(this, arguments);
    stack.slice(before).forEach((layer, i) => {
      if (fns[i] && fns[i].handle && fns[i].set) layer.subApp = fns[i];
    });
    return result;
  };

  try {
    return build();
  } finally {
    Router.prototype.use = routerUse;
    express.application.use = appUse;
  }
}

function joinPath (prefix, path) {
  if (path === '/' || path === '') return prefix;
  return (prefix + '/' + path).replace(/\/+/g, '/');
}

// '/:collection/history/:lastModified' -> '/{collection}/history/{lastModified}'
function toTemplate (path) {
  return path.replace(/:(\w+)/g, '{$1}');
}

// Each entry: {method, path} where path is an OpenAPI-style template, or a
// RegExp source wrapped in slashes when the code registered a RegExp.
function routes (app, prefix = '') {
  const out = new Map();
  const seen = new Map(); // stack -> prefixes already walked

  function add (method, path) {
    out.set(method + ' ' + path, {method, path});
  }

  function walk (stack, prefix) {
    const prefixes = seen.get(stack) || new Set();
    if (prefixes.has(prefix)) return;
    seen.set(stack, prefixes.add(prefix));
    for (const layer of stack) {
      if (layer.route) {
        const routePath = layer.route.path;
        const methods = layer.route.methods._all ? ['all'] : METHODS.filter(m => layer.route.methods[m]);
        // `app.all(/^\/entries.*$/i, router)` hands the request, unchanged, to
        // a router: the router's own routes are the real table.
        const routers = layer.route.stack.map(l => l.handle).filter(h => h && Array.isArray(h.stack));
        if (routers.length) {
          routers.forEach(r => walk(r.stack, prefix));
          continue;
        }
        for (const p of [].concat(routePath)) {
          const path = p instanceof RegExp ? prefix + '/' + p.source + '/' : toTemplate(joinPath(prefix, p));
          methods.forEach(m => add(m, path));
        }
      } else if (layer.subApp) {
        walk(layer.subApp.router.stack, joinPath(prefix, layer.mountPath || '/'));
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, joinPath(prefix, layer.mountPath || '/'));
      }
    }
  }

  walk(app.router.stack, prefix);
  return Array.from(out.values());
}

module.exports = {capture, routes, toTemplate};
