'use strict';

// Keep the persisted js-storage format: raw strings (including clock auth),
// JSON objects, and JSON parsing with a raw fallback on reads. No cookie shim.
const own = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
const put = (object, key, value) => Object.defineProperty(object, key, {value, writable: true, enumerable: true, configurable: true});
const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const decode = raw => {try {return JSON.parse(raw);} catch (_) {return raw;}};
const empty = value => plain(value) ? Object.keys(value).length === 0 : Array.isArray(value) ? value.length === 0 : typeof value !== 'boolean' && !value;

function backend(name) {
  try {
    const storage = typeof window === 'undefined' ? null : window[name];
    if (!storage) return null;
    // A readable storage object can still have zero quota. Unlike the old
    // jsapi probe, preserve any existing data at this temporary key.
    const key = '__nightscout_storage_probe__', previous = storage.getItem(key);
    storage.setItem(key, previous === null ? '1' : previous);
    if (previous === null) storage.removeItem(key);
    return storage;
  } catch (_) {return null;}
}

const local = backend('localStorage'), session = backend('sessionStorage');
const namespaces = {};

function adapter(storage, namespace = '') {
  function path(args) {
    const result = Array.from(args);
    if (typeof result[0] === 'string') result.splice(0, 1, ...result[0].split('.'));
    if (namespace) result.unshift(namespace);
    return result;
  }
  function get(keys) {
    if (!keys.length) throw new Error('Minimum 1 argument must be given');
    if (Array.isArray(keys[0])) return Object.fromEntries(keys[0].map(key => [key, decode(storage.getItem(key))]));
    let value = decode(storage.getItem(keys[0]));
    for (let i = 1; i < keys.length; i++) {
      if (value == null || i === 1 && !value) throw new ReferenceError(keys.slice(0, i).join('.') + ' is not defined in this storage');
      const key = keys[i];
      if (Array.isArray(key)) return Object.fromEntries(key.map(name => [name, own(value, name) ? value[name] : undefined]));
      value = own(value, key) ? value[key] : undefined;
    }
    return value;
  }
  function write(key, value) {
    storage.setItem(key, typeof value === 'object' || api.alwaysUseJson ? JSON.stringify(value) : value);
  }
  const api = {
    alwaysUseJson: false,
    get(...args) {return storage ? get(path(args)) : null;},
    set(...args) {
      if (!args.length || !plain(args[0]) && args.length < 2) throw new Error('Minimum 2 arguments must be given or first parameter must be an object');
      if (!storage) return null;
      if (plain(args[0])) {
        for (const [key, value] of Object.entries(args[0])) {
          if (namespace) api.set(key, value);
          // Retain the old bulk-set array coercion (single-key set uses JSON).
          else storage.setItem(key, plain(value) || api.alwaysUseJson ? JSON.stringify(value) : value);
        }
        return args[0];
      }
      const keys = path(args), value = keys.pop(), root = keys.shift();
      if (!keys.length) {write(root, value); return value;}
      let stored = decode(storage.getItem(root));
      if (!stored || typeof stored !== 'object') stored = isNaN(keys[0]) ? {} : [];
      let node = stored;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i], array = !isNaN(keys[i + 1]);
        if (!own(node, key) || (array ? !Array.isArray(node[key]) : !plain(node[key]))) put(node, key, array ? [] : {});
        node = node[key];
      }
      put(node, keys[keys.length - 1], value);
      write(root, stored);
      return namespace ? stored[String(args[0]).split('.')[0]] : stored;
    },
    remove(...args) {
      if (!args.length) throw new Error('Minimum 1 argument must be given');
      if (!storage) return null;
      const keys = path(args), root = keys.shift();
      if (Array.isArray(root)) root.forEach(key => storage.removeItem(key));
      else if (!keys.length) storage.removeItem(root);
      else {
        const stored = decode(storage.getItem(root));
        let node = stored;
        for (const key of keys.slice(0, -1)) {
          if (!own(node, key)) throw new ReferenceError(String(key) + ' is not defined in this storage');
          node = node[key];
        }
        if (node == null) throw new ReferenceError(String(root) + ' is not defined in this storage');
        const last = keys[keys.length - 1];
        for (const key of Array.isArray(last) ? last : [last]) delete node[key];
        write(root, stored);
      }
      return true;
    },
    keys(...args) {
      if (!storage) return null;
      if (args.length || namespace) return Object.keys(get(path(args)) || {});
      return Array.from({length: storage.length}, (_, index) => storage.key(index));
    },
    isSet(...args) {
      if (!args.length) throw new Error('Minimum 1 argument must be given');
      if (!storage) return null;
      if (Array.isArray(args[0])) return args[0].every(key => api.isSet(key));
      try {
        const value = get(path(args));
        return Array.isArray(args[args.length - 1]) ? Object.values(value).every(item => item != null) : value != null;
      } catch (_) {return false;}
    },
    isEmpty(...args) {
      if (!storage) return null;
      if (!args.length) return api.keys().length === 0;
      if (Array.isArray(args[0])) return args[0].every(key => api.isEmpty(key));
      try {
        const value = get(path(args));
        return Array.isArray(args[args.length - 1]) ? Object.values(value).every(empty) : empty(value);
      } catch (_) {return true;}
    },
    removeAll(reinitialize) {
      if (!storage) return null;
      if (namespace) {write(namespace, {}); return true;}
      storage.clear();
      if (reinitialize) Object.keys(namespaces).forEach(name => exported.initNamespaceStorage(name));
    }
  };
  return api;
}

const exported = {
  localStorage: adapter(local), sessionStorage: adapter(session), namespaceStorages: namespaces,
  initNamespaceStorage(name) {
    if (!name || typeof name !== 'string') throw new Error('First parameter must be a string');
    for (const storage of [local, session]) if (storage && !storage.getItem(name)) storage.setItem(name, '{}');
    const group = {localStorage: adapter(local, name), sessionStorage: adapter(session, name)};
    group.localStorage.alwaysUseJson = exported.localStorage.alwaysUseJson;
    group.sessionStorage.alwaysUseJson = exported.sessionStorage.alwaysUseJson;
    put(namespaces, name, group);
    return group;
  },
  removeAllStorages(reinitialize) {
    exported.localStorage.removeAll(reinitialize); exported.sessionStorage.removeAll(reinitialize);
    if (!reinitialize) Object.keys(namespaces).forEach(name => delete namespaces[name]);
  },
  alwaysUseJsonInStorage(value) {
    exported.localStorage.alwaysUseJson = value; exported.sessionStorage.alwaysUseJson = value;
  }
};
module.exports = exported;
