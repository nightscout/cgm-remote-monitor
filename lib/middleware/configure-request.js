'use strict';

const qs = require('qs');

// Express 5 reparses req.query on each access. Nightscout's API handlers build
// and refine filters across middleware, so retain one mutable query per request.
module.exports = function configureRequest(app) {
  app.set('query parser', value => qs.parse(value, {
    allowPrototypes: true, arrayLimit: 1000, parameterLimit: 1000
  }));
  app.use(function preserveRequest(req, res, next) {
    if (!Object.prototype.hasOwnProperty.call(req, 'query')) {
      Object.defineProperty(req, 'query', {
        value: req.query, writable: true, enumerable: true, configurable: true
      });
    }
    // Express 4 parsers supplied an empty object for an unparsed body. Keep
    // that contract for legacy handlers; a matching parser still replaces it.
    if (req.body === undefined) req.body = {};
    next();
  });
};
