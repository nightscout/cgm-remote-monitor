'use strict';

// Persisted values intentionally retain js-storage's format: strings are raw,
// objects are JSON, and reads parse valid JSON before falling back to raw text.
// The clock reads apisecrethash directly with the native getItem API.
function adapter(name) {
  let backend;
  try {
    backend = typeof window === 'undefined' ? null : window[name];
    if (backend) {
      // Verify writes as well as access (private browsing can expose a storage
      // object with zero quota). Preserve any existing value at the probe key.
      const key = '__nightscout_storage_probe__';
      const previous = backend.getItem(key);
      backend.setItem(key, previous === null ? '1' : previous);
      if (previous === null) backend.removeItem(key);
    }
  } catch (_) { backend = null; }

  const decode = raw => { try {return JSON.parse(raw);} catch (_) {return raw;} };
  const parts = key => String(key).split('.');
  const own = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
  const put = (object, key, value) => Object.defineProperty(object, key, {value, writable: true, enumerable: true, configurable: true});
  const api = {
    alwaysUseJson: false,
    get(key) {
      if (arguments.length === 0) throw new Error('Minimum 1 argument must be given');
      if (!backend) return null;
      if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, api.get(item)]));
      const path = parts(key);
      let value = decode(backend.getItem(path.shift()));
      for (const segment of path) {
        if (value == null) throw new ReferenceError(String(key) + ' is not defined in this storage');
        value = own(value, segment) ? value[segment] : undefined;
      }
      return value;
    },
    set(key, value) {
      if (arguments.length < 2) throw new Error('Minimum 2 arguments must be given');
      if (!backend) return null;
      const path = parts(key), root = path.shift();
      let stored = value;
      if (path.length) {
        stored = decode(backend.getItem(root));
        if (!stored || typeof stored !== 'object') stored = isNaN(path[0]) ? {} : [];
        let node = stored;
        for (let i = 0; i < path.length - 1; i++) {
          const segment = path[i];
          if (!own(node, segment) || !node[segment] || typeof node[segment] !== 'object') put(node, segment, isNaN(path[i + 1]) ? {} : []);
          node = node[segment];
        }
        put(node, path[path.length - 1], value);
      }
      backend.setItem(root, typeof stored === 'object' || api.alwaysUseJson ? JSON.stringify(stored) : stored);
      return stored;
    },
    remove(key) {
      if (arguments.length === 0) throw new Error('Minimum 1 argument must be given');
      if (!backend) return null;
      if (Array.isArray(key)) {key.forEach(item => api.remove(item)); return true;}
      const path = parts(key), root = path.shift();
      if (!path.length) backend.removeItem(root);
      else {
        const stored = decode(backend.getItem(root));
        let node = stored;
        for (const segment of path.slice(0, -1)) {
          if (!own(node, segment)) throw new ReferenceError(String(key) + ' is not defined in this storage');
          node = node[segment];
        }
        if (node == null) throw new ReferenceError(String(key) + ' is not defined in this storage');
        delete node[path[path.length - 1]];
        backend.setItem(root, JSON.stringify(stored));
      }
      return true;
    },
    keys() {
      if (!backend) return null;
      return Array.from({length: backend.length}, (_, index) => backend.key(index));
    }
  };
  return api;
}

module.exports = {localStorage: adapter('localStorage'), sessionStorage: adapter('sessionStorage')};
