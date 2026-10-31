'use strict';

// Query conversion mutates own enumerable string-keyed leaves. Keep the root
// replacement return value (callers intentionally ignore it), object identity,
// sparse arrays and ancestor cycles without implementing a general tree API.
//
// `convert(value, path)` receives the key path from `root` to the leaf, so a
// caller can tell an operand from a value: `['$in', '0']` is a value drawn from
// the field's domain, `['$exists']` is a yes/no question and `['$regex']` a
// pattern. The path is a fresh array on each call.
//
// A driver value (ObjectId, Long, Decimal128, ...) is a leaf even though its
// class keeps own enumerable fields: bson 7's ObjectId stores its bytes in
// i0..i3. Such classes declare `_bsontype` on their prototype; an own
// `_bsontype` key, which request data can carry, does not make a leaf.
function childKeys(value) {
  if (value === null || typeof value !== 'object') return [];
  if (typeof value._bsontype === 'string' && !Object.prototype.hasOwnProperty.call(value, '_bsontype')) return [];
  return Object.keys(value);
}

module.exports = function queryLeaves(root, convert) {
  const ancestors = new Set();
  const path = [];
  function visit(value, parent, key) {
    let keys = childKeys(value);
    if (keys.length === 0) {
      value = convert(value, path.slice());
      if (parent) parent[key] = value;
      keys = childKeys(value);
    }
    if (keys.length && !ancestors.has(value)) {
      ancestors.add(value);
      for (const child of keys) {
        path.push(child);
        visit(value[child], value, child);
        path.pop();
      }
      ancestors.delete(value);
    }
    return value;
  }
  return visit(root);
};
