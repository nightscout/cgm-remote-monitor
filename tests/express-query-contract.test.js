'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const configureQuery = require('../lib/middleware/configure-request');

function createApp() {
  const app = express();
  configureQuery(app);
  return app;
}

describe('Nightscout query lifecycle', function () {
  it('retains filter mutations and replacement through a mounted API', async function () {
    const app = createApp();
    const api = createApp();
    app.use((req, res, next) => {
      req.query.find.sgv.$gte = 80;
      delete req.query.find._id;
      req.query = {find: req.query.find, count: '10'};
      next();
    });
    api.get('/entries', (req, res) => res.json(req.query));
    app.use('/api/v1', api);
    const result = await request(app).get('/api/v1/entries?find[_id]=old&find[sgv][$gte]=70').expect(200);
    assert.deepEqual(result.body, {find: {sgv: {$gte: 80}}, count: '10'});
  });

  it('keeps the original query when routing rewrites the URL', async function () {
    const app = createApp();
    app.use((req, res, next) => {req.url = '/rewritten?count=99'; next();});
    app.get('/rewritten', (req, res) => res.json(req.query));
    const result = await request(app).get('/original?count=5').expect(200);
    assert.deepEqual(result.body, {count: '5'});
  });

  it('does not share query mutations with a later request', async function () {
    const app = createApp();
    app.get('/', (req, res) => {
      const previous = req.query.changed;
      req.query.changed = true;
      res.json({previous: previous || false});
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await request(app).get('/').expect(200);
      assert.deepEqual(result.body, {previous: false});
    }
  });

  for (const notation of ['repeated', 'bracket', 'indexed']) {
    it('preserves 1000 values and caps query parameters with ' + notation + ' notation', async function () {
      const app = createApp();
      app.get('/', (req, res) => res.json(req.query));
      const parameters = Array.from({length: 1001}, (_, i) =>
        'v' + (notation === 'bracket' ? '[]' : notation === 'indexed' ? '[' + i + ']' : '') + '=' + i);
      const result = await request(app).get('/?' + parameters.join('&')).expect(200);
      assert.deepEqual(result.body.v, Array.from({length: 1000}, (_, i) => String(i)));
    });
  }

  it('ignores prototype pollution keys while preserving ordinary filters', async function () {
    const app = createApp();
    app.get('/', (req, res) => res.json(req.query));
    const result = await request(app).get('/?__proto__[polluted]=yes&constructor[prototype][polluted]=yes&find[sgv][$gte]=80').expect(200);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.hasOwn(result.body, '__proto__'), false);
    assert.deepEqual(result.body.find, {sgv: {$gte: '80'}});
  });
});
