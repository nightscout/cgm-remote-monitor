'use strict';

// Public filters support MongoDB operators, but must not submit executable
// JavaScript to the database. Values inside literal comparisons remain data.
module.exports = function assertNoQueryJavascript(root) {
  const pending = [{value:root, expression:false}];
  const visited = new WeakMap();
  while (pending.length) {
    const {value, expression} = pending.pop();
    if (!value || typeof value !== 'object') continue;
    const mode = expression ? 2 : 1;
    if ((visited.get(value) || 0) & mode) continue;
    visited.set(value, (visited.get(value) || 0) | mode);
    for (const key of Object.keys(value)) {
      if (key === '$where' || key === '$function' || key === '$accumulator') {
        const error = new Error('Server-side JavaScript is not allowed in database queries');
        error.name = 'MongoQueryValidationError';
        error.status = error.statusCode = 400;
        throw error;
      }
      // Aggregation $literal and query/schema literal values are never code.
      if (expression && key === '$literal') continue;
      if (!expression && ['$eq', '$ne', '$in', '$nin', '$jsonSchema'].includes(key)) continue;
      if (!expression && key === '$all' && Array.isArray(value[key])) {
        for (const item of value[key]) {
          if (item && Object.prototype.hasOwnProperty.call(item, '$elemMatch')) {
            pending.push({value:item.$elemMatch, expression:false});
          }
        }
        continue;
      }
      pending.push({value:value[key], expression:key === '$match' ? false : expression || key === '$expr'});
    }
  }
  return root;
};
