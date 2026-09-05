'use strict';

const assert = require('assert');
const request = require('supertest');
const express = require('express');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const zlib = require('zlib');
const configureWares = require('../lib/middleware');
const query = require('../lib/server/query');
const MiB = 1024 * 1024;

function appWithParser (parser, handler) {
  const app = express();
  app.post('/', parser, handler || ((req, res) => res.json(req.body)));
  app.use(function (error, req, res, next) {
    res.status(error.status || 500).json({type: error.type});
    void next;
  });
  return app;
}

function post (app, type, body) {
  return request(app).post('/').set('Content-Type', type).send(body);
}

describe('Express and body-parser dependency compatibility', function () {
  it('uses the patched body-parser for Express built-in parsers as well', function () {
    const fromExpress = createRequire(require.resolve('express'));
    assert.strictEqual(fromExpress.resolve('body-parser'), require.resolve('body-parser'));
    assert.throws(() => express.json({limit: 'invalid'}), TypeError);
    assert.throws(() => express.urlencoded({extended: true, limit: NaN}), TypeError);
  });

  [
    ['json', bodyParser.json, 'application/json', size => JSON.stringify('x'.repeat(size)), {strict: false}],
    ['urlencoded', bodyParser.urlencoded, 'application/x-www-form-urlencoded', size => 'v=' + 'x'.repeat(size), {extended: true}],
    ['raw', bodyParser.raw, 'application/octet-stream', size => Buffer.alloc(size, 120), {}],
    ['text', bodyParser.text, 'text/plain', size => 'x'.repeat(size), {}]
  ].forEach(function ([name, parser, type, payload, options]) {
    ['invalid', NaN].forEach(function (limit) {
      it(name + ' rejects invalid size limit ' + String(limit) + ' at construction', function () {
        assert.throws(() => parser(Object.assign({}, options, {limit: limit})), /option limit .* is invalid/);
      });
    });
    it(name + ' retains the default 100kb cap for null and undefined limits', async function () {
      for (const limit of [null, undefined]) {
        const app = appWithParser(parser(Object.assign({}, options, {limit: limit})), (req, res) => res.sendStatus(204));
        await post(app, type, payload(100)).expect(204);
        const response = await post(app, type, payload(102401)).expect(413);
        assert.strictEqual(response.body.type, 'entity.too.large');
      }
    });
  });

  [
    ['json', 'application/json', size => JSON.stringify({value: 'x'.repeat(size - 12)}), wares => wares.jsonParser],
    ['form', 'application/x-www-form-urlencoded', size => 'value=' + 'x'.repeat(size - 6), wares => wares.urlencodedParser],
    ['raw', 'application/octet-stream', size => Buffer.alloc(size, 120), wares => wares.rawParser]
  ].forEach(function ([name, type, payload, parser]) {
    it('enforces Nightscout\'s 1MiB ' + name + ' boundary without lowering it', async function () {
      const app = appWithParser(parser(configureWares({settings: {}})), (req, res) => res.sendStatus(204));
      assert.strictEqual(Buffer.byteLength(payload(MiB)), MiB);
      await post(app, type, payload(MiB)).expect(204);
      const response = await post(app, type, payload(MiB + 1)).expect(413);
      assert.strictEqual(response.body.type, 'entity.too.large');
    });
  });

  it('preserves nested upload fields and arrays above 100 elements in form bodies', async function () {
    const app = appWithParser(configureWares({settings: {}}).urlencodedParser);
    const parts = Array.from({length: 125}, (_, i) => 'entries[' + i + '][sgv]=' + (100 + i));
    const response = await post(app, 'application/x-www-form-urlencoded', parts.join('&')).expect(200);
    assert.ok(Array.isArray(response.body.entries));
    assert.strictEqual(response.body.entries.length, 125);
    assert.deepStrictEqual(response.body.entries[124], {sgv: '224'});
  });

  it('keeps the 50000-parameter form limit enforced', async function () {
    const app = appWithParser(configureWares({settings: {}}).urlencodedParser,
      (req, res) => res.json({count: Object.keys(req.body).length}));
    const form = Array.from({length: 50000}, (_, i) => 'p' + i + '=x').join('&');
    const response = await post(app, 'application/x-www-form-urlencoded', form).expect(200);
    assert.strictEqual(response.body.count, 50000);
    const rejected = await post(app, 'application/x-www-form-urlencoded', form + '&extra=x').expect(413);
    assert.strictEqual(rejected.body.type, 'parameters.too.many');
  });

  it('accepts a bulk JSON upload above 1MiB with both API limit formats', async function () {
    const payload = JSON.stringify([{type: 'sgv', sgv: 123, device: 'x'.repeat(MiB + 1)}]);
    for (const limit of ['50Mb', 1048576 * 50]) {
      const app = appWithParser(bodyParser.json({limit: limit}), (req, res) => {
        assert.ok(Array.isArray(req.body));
        res.json({count: req.body.length, sgv: req.body[0].sgv});
      });
      const response = await post(app, 'application/json', payload).expect(200);
      assert.deepStrictEqual(response.body, {count: 1, sgv: 123});
    }
  });

  it('parses a compressed JSON upload and enforces the inflated size limit', async function () {
    const app = appWithParser(configureWares({settings: {}}).jsonParser);
    const data = {type: 'sgv', sgv: 123};
    const response = await request(app).post('/').set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip').serialize(body => body).send(zlib.gzipSync(JSON.stringify(data))).expect(200);
    assert.deepStrictEqual(response.body, data);
    const rejected = await request(app).post('/').set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip').serialize(body => body).send(zlib.gzipSync(JSON.stringify({v: 'x'.repeat(MiB)}))).expect(413);
    assert.strictEqual(rejected.body.type, 'entity.too.large');
  });

  ['{broken', '42', 'null'].forEach(function (payload) {
    it('rejects malformed or non-container JSON: ' + payload, async function () {
      const app = appWithParser(configureWares({settings: {}}).jsonParser);
      const response = await post(app, 'application/json', payload).expect(400);
      assert.strictEqual(response.body.type, 'entity.parse.failed');
    });
  });

  it('does not pollute object prototypes from encoded request bodies', async function () {
    const app = appWithParser(configureWares({settings: {}}).urlencodedParser);
    const response = await post(app, 'application/x-www-form-urlencoded',
      '__proto__[polluted]=yes&constructor[prototype][polluted]=yes&notes=Fish%20%26%20Chips').expect(200);
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body, '__proto__'), false);
    assert.strictEqual(response.body.notes, 'Fish & Chips');
  });

  ['repeated', 'bracket', 'indexed'].forEach(function (notation) {
    it('preserves 25-value query filter arrays using ' + notation + ' notation through Nightscout query conversion', async function () {
      const app = express();
      app.use(configureWares({settings: {}}).extensions(['json']));
      app.get('/entries', (req, res) => res.json(query(req.query, {noDateFilter: true})));
      const expected = Array.from({length: 25}, (_, i) => 100 + i);
      const parts = expected.map((value, index) => 'find[sgv][$in]' +
        (notation === 'bracket' ? '[]' : notation === 'indexed' ? '[' + index + ']' : '') + '=' + value);
      const response = await request(app).get('/entries.json?' + parts.join('&')).expect(200);
      assert.deepStrictEqual(response.body.sgv.$in, expected);
    });
  });

  it('retains the default 1000-query-parameter cap', async function () {
    const app = express();
    app.get('/', (req, res) => res.json(req.query));
    const response = await request(app).get('/?' + Array.from({length: 1001}, (_, i) => 'v=' + i).join('&')).expect(200);
    assert.ok(Array.isArray(response.body.v));
    assert.strictEqual(response.body.v.length, 1000);
    assert.strictEqual(response.body.v[999], '999');
  });

  it('keeps nested date filters, content negotiation and legacy wildcard routing', async function () {
    const app = express();
    app.use(configureWares({settings: {}}).extensions(['json']));
    app.all('/entries*', (req, res) => res.json({path: req.path, accept: req.get('accept'),
      filter: query(req.query, {noDateFilter: true})}));
    const response = await request(app)
      .get('/entries/sgv.json?find[date][$gte]=1700000000000&find[sgv][$gte]=80').expect(200);
    assert.strictEqual(response.body.path, '/entries/sgv');
    assert.strictEqual(response.body.accept, 'application/json');
    assert.strictEqual(response.body.filter.date.$gte, 1700000000000);
    assert.strictEqual(response.body.filter.sgv.$gte, 80);
  });
});
