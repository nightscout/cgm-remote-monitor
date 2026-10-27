'use strict';

const swaggerUi = require('swagger-ui-express');

module.exports = function registerApiDocs(app) {
  for (const [route, schema] of [
    ['/api-docs', require('./swagger.json')],
    ['/api3-docs', require('../api3/swagger.json')]
  ]) {
    // Each mount owns its initializer. The shared `serve` middleware uses
    // mutable module-wide state and can return the other API's schema.
    app.use(route, swaggerUi.serveFiles(schema), swaggerUi.setup(schema));
  }
  app.use('/swagger-ui-dist', (req, res) => res.redirect(307, '/api-docs'));
};
