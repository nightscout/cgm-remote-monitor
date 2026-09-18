'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
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
  it('loads server documentation middleware without evaluating browser bundles', function () {
    const output = execFileSync(process.execPath, ['-e', `
      require(process.argv[1]);
      process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(file =>
        /swagger-ui-(bundle|standalone-preset)\\.js$/.test(file))));
    `, require.resolve('../lib/server/api-docs')], {encoding: 'utf8', timeout: 5000});
    assert.deepEqual(JSON.parse(output), []);
  });
  it('honors the project installation-analytics opt-out before making a request', function () {
    this.timeout(10000);
    const root = path.resolve(__dirname, '..');
    const env = {INIT_CWD: root, PATH: process.env.PATH, HOME: process.env.HOME,
      npm_execpath: path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')};
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      let requests = 0;
      const deny = () => {requests++; throw new Error('Unexpected analytics request');};
      require('node:https').request = deny;
      require('node:http').request = deny;
      const scarf = require(process.argv[1]);
      assert.rejects(scarf.reportPostInstall(), /opted out|disabled/i).then(() => {
        assert.equal(requests, 0);
      }).catch(error => {console.error(error); process.exitCode = 1;});
    `, require.resolve('@scarf/scarf')], {cwd: root, env, encoding: 'utf8', timeout: 8000});
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
