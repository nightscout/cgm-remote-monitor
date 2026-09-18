'use strict';

// Query conversion mutates own enumerable string-keyed leaves. Keep the root
// replacement return value (callers intentionally ignore it), object identity,
// sparse arrays and ancestor cycles without implementing a general tree API.
module.exports = function queryLeaves(root, convert) {
  const ancestors = new Set();
  function visit(value, parent, key) {
    let keys = value !== null && typeof value === 'object' ? Object.keys(value) : [];
    if (keys.length === 0) {
      value = convert(value);
      if (parent) parent[key] = value;
      keys = value !== null && typeof value === 'object' ? Object.keys(value) : [];
    }
    if (keys.length && !ancestors.has(value)) {
      ancestors.add(value);
      for (const child of keys) visit(value[child], value, child);
      ancestors.delete(value);
    }
    return value;
  }
  return visit(root);
};
