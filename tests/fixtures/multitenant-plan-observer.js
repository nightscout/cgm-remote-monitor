'use strict';

// Records which fields the role configuration loaders read from each document
// they parse, so a test can compare the loaders with the published plan
// contract (tests/multitenant-plan-contract.test.js). Every loader parses its
// file through lib/server/serve/config-file.js (`parse` or `readJson`, each
// called with the `label` of the environment variable that names the file);
// while installed, those two return the parsed value behind a recording Proxy.
//
//   const observer = install();           // patches config-file
//   ... run loaders ...
//   observer.reads('MULTITENANT_PREVIEW_CONFIG')   -> Map(path -> Set(field))
//   observer.restore();
//
// A path is a JSON Pointer with every array index written `*`. A read of a
// field the document does not carry is recorded too: that is how an optional
// field a loader accepts is seen when the document leaves it out.
const configFile = require('../../lib/server/serve/config-file');

const IGNORED = new Set(['toJSON', 'then', 'constructor', 'valueOf', 'toString', 'inspect', 'nodeType', 'asymmetricMatch']);

function install () {
  const original = { parse: configFile.parse, readJson: configFile.readJson };
  const records = new Map();
  const proxies = new WeakMap();
  function wrap (value, label, path) {
    if (value === null || typeof value !== 'object') return value;
    if (proxies.has(value)) return proxies.get(value);
    const isArray = Array.isArray(value);
    const note = key => {
      if (isArray || typeof key !== 'string' || IGNORED.has(key)) return;
      if (!records.has(label)) records.set(label, new Map());
      const paths = records.get(label);
      if (!paths.has(path)) paths.set(path, new Set());
      paths.get(path).add(key);
    };
    const proxy = new Proxy(value, {
      get (target, key, receiver) {
        note(key);
        const child = Reflect.get(target, key, receiver);
        return typeof key === 'string' ? wrap(child, label, path + '/' + (isArray ? '*' : key)) : child;
      },
      // Object.hasOwn(value, 'field') and 'field' in value: a field asked about is a field known.
      getOwnPropertyDescriptor (target, key) { note(key); return Reflect.getOwnPropertyDescriptor(target, key); },
      has (target, key) { note(key); return Reflect.has(target, key); }
    });
    proxies.set(value, proxy);
    return proxy;
  }
  configFile.parse = (text, options = {}) => wrap(original.parse(text, options), options.label, '');
  configFile.readJson = (file, options = {}) => wrap(original.parse(configFile.read(file, options), options), options.label, '');
  return {
    reads: label => records.get(label) || new Map(),
    labels: () => [...records.keys()],
    restore () { configFile.parse = original.parse; configFile.readJson = original.readJson; }
  };
}

module.exports = { install };
