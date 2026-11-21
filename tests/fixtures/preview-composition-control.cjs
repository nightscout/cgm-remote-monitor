'use strict';

// Test-child fault injection only. There is no application-selected fault mode.
const Module = require('node:module');
const original = Module._load;
Module._load = function (request, parent, isMain) {
  const result = original.call(this, request, parent, isMain);
  const filename = Module._resolveFilename(request, parent);
  if (process.env.NS_PREVIEW_COMPOSITION_FAULT === 'catalogue' &&
      filename.endsWith('/migrations/candidates/postgres-entries-v1.json')) {
    return original.call(this, require.resolve('../../migrations/candidates/postgres-food-v1.json'), parent, isMain);
  }
  if (filename.endsWith('/lib/server/serve/postgres-domains.js')) {
    if (!result.compositionControl) {
      const get = result.get;
      result.get = logical => {
        const selected = get(logical);
        if (process.env.NS_PREVIEW_COMPOSITION_FAULT === 'intent') {
          return { ...selected, factory (options) {
            const port = selected.factory(options);
            delete port.intentFactory;
            return port;
          } };
        }
        return selected;
      };
      result.compositionControl = true;
    }
  }
  return result;
};
