'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const EventEmitter = require('node:events');

// Real entries router/storage code with an owned in-memory collection boundary.
// Authentication is outside this format/batch fixture; real API tests cover it.
function fixture(rows = [], deNormalizeDates = true) {
  const state = {writes: [], purifications: 0};
  const env = {settings: {deNormalizeDates}, entries_collection: 'entry_transform_test'};
  const collection = {bulkWrite: async (ops, options) => {
    state.writes.push({ops, options});
    return {upsertedIds: {}};
  }};
  const ctx = {store: {collection: () => collection}, bus: new EventEmitter(),
    purifier: {purifyObject: () => state.purifications++},
    ddata: {sgvs: [], processRawDataForRuntime: docs => docs}, cache: {entries: [], getData: () => []},
    authorization: {isPermitted: () => (req, res, next) => next()}};
  ctx.entries = require('../lib/server/entries')(env, ctx);
  ctx.entries.list = (query, done) => done(null, structuredClone(rows));
  const app = express(); app.enable('api');
  app.use(require('../lib/api/entries')(app, require('../lib/middleware')(env), ctx, env));
  return {app, state, entries: ctx.entries};
}

const rows = [
  {date: 1735682400000, dateString: '2024-12-31T22:00:00.000Z', utcOffset: 120, sgv: 100, direction: 'Flat', device: 'fixture'},
  {date: 1735682700000, dateString: '2024-12-31T22:05:00.000Z', utcOffset: 120, sgv: 110, direction: 'SingleUp', device: 'fixture'}
];
const url = '/entries/sgv?find[date][$gte]=0';

describe('Entry transform and batch contracts', function () {
  it('sorts, supplies the requested type and restores date offsets in JSON', async function () {
    const {app} = fixture(rows);
    const response = await request(app).get(url).set('Accept', 'application/json').expect(200);
    assert.deepEqual(response.body, rows.slice().reverse().map((row, index) => ({
      date: row.date, dateString: '2025-01-01T00:0' + (index ? '0' : '5') + ':00.000+02:00',
      sgv: row.sgv, direction: row.direction, device: row.device, type: 'sgv'
    })));
    assert.equal(response.headers['last-modified'], new Date(rows[1].date).toUTCString());
    assert.equal(rows[0].utcOffset, 120, 'The collection fixture stays unchanged');
  });
  for (const [accept, separator] of [['text/plain', '\t'], ['text/tab-separated-values', '\t'], ['text/csv', ',']]) {
    it('preserves exact ' + accept + ' field order, quoting and CRLF', async function () {
      const {app} = fixture(rows);
      const response = await request(app).get(url).set('Accept', accept).expect(200);
      const expected = [
        ['"2025-01-01T00:05:00.000+02:00"', '1735682700000', '110', '"SingleUp"', '"fixture"'],
        ['"2025-01-01T00:00:00.000+02:00"', '1735682400000', '100', '"Flat"', '"fixture"']
      ].map(fields => fields.join(separator)).join('\r\n');
      assert.equal(response.text, expected);
    });
  }
  it('preserves the existing JSON fallback for an SVG Accept request', async function () {
    const {app} = fixture(rows, false);
    const response = await request(app).get(url).set('Accept', 'image/svg+xml').expect(200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(response.body, rows.slice().reverse().map(row => ({...row, type: 'sgv'})));
  });
  it('returns an empty array or empty text for an empty collection', async function () {
    const {app} = fixture();
    assert.deepEqual((await request(app).get(url).set('Accept', 'application/json').expect(200)).body, []);
    assert.equal((await request(app).get(url).set('Accept', 'text/csv').expect(200)).text, '');
  });
  it('retains conditional 304 responses without a response body', async function () {
    const {app} = fixture(rows);
    const response = await request(app).get(url).set('If-Modified-Since', new Date(rows[1].date).toUTCString()).expect(304);
    assert.equal(response.text, '');
  });
  it('previews ordered batches without touching persistence', async function () {
    const {app, state} = fixture();
    const response = await request(app).post('/entries/preview').send(rows).expect(200);
    assert.deepEqual(response.body, rows);
    assert.equal(state.writes.length, 0);
    assert.equal(state.purifications, rows.length);
  });
  it('writes one ordered batch and returns its input order', async function () {
    const {app, state} = fixture();
    const response = await request(app).post('/entries').send(rows).expect(200);
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.writes[0].options, {ordered: true});
    assert.deepEqual(response.body.map(row => row.sgv), [100, 110]);
    assert.equal(state.purifications, rows.length);
  });
  it('keeps empty and undated single-object writes as no-ops', async function () {
    const {app, state} = fixture();
    for (const input of [[], {sgv: 100}]) assert.deepEqual((await request(app).post('/entries').send(input).expect(200)).body, []);
    assert.equal(state.writes.length, 0);
  });
});
