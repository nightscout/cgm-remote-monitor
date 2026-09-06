'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const registerApiDocs = require('../lib/server/api-docs');

function configuredSchema(source) {
  let configuration;
  const bundle = config => {configuration = config; return {};};
  bundle.presets = {apis: {}};
  bundle.plugins = {DownloadUrl: {}};
  const context = {window: {location: {search: '', origin: 'http://127.0.0.1'}},
    SwaggerUIBundle: bundle, SwaggerUIStandalonePreset: {}};
  vm.runInNewContext(source, context, {timeout: 1000});
  context.window.onload();
  return JSON.parse(JSON.stringify(configuration.spec));
}

describe('Swagger documentation route isolation', function () {
  const app = express();
  registerApiDocs(app);
  const documents = [
    ['/api-docs', require('../lib/server/swagger.json')],
    ['/api3-docs', require('../lib/api3/swagger.json')]
  ];
  it('preserves each schema when HTML and initializer requests interleave', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      await Promise.all(documents.map(([route]) => request(app).get(route + '/').expect(200)));
      for (const [route, schema] of documents.slice().reverse()) {
        const response = await request(app).get(route + '/swagger-ui-init.js').expect(200);
        assert.deepEqual(configuredSchema(response.text), schema);
      }
    }
  });
  it('serves assets and redirects legacy docs while refusing package metadata', async function () {
    await request(app).get('/swagger-ui-dist').expect(307).expect('Location', '/api-docs');
    for (const [route] of documents) {
      await request(app).get(route).expect(301);
      await request(app).get(route + '/swagger-ui.css').expect(200).expect('Content-Type', /text\/css/);
      const response = await request(app).get(route + '/swagger-ui-bundle.js').expect(200);
      assert(response.text.includes('SwaggerUIBundle'));
      await request(app).get(route + '/package.json').expect(404);
    }
  });
});
