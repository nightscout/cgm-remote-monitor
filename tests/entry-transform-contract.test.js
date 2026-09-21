'use strict';

const assert = require('node:assert/strict');
const request = require('supertest');
const path = require('node:path');
const implementation = process.env.NIGHTSCOUT_ENTRIES_ORACLE_ROOT || path.resolve(__dirname, '..');

const createFixture = require('./fixtures/entry-transforms');
const fixture = (rows, dates) => createFixture(rows, dates, implementation);

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
  it('preserves the 10,000-entry boundary as one ordered storage call', async function () {
    const {app, state} = fixture();
    const batch = Array.from({length: 10000}, (_, i) => ({date: rows[0].date + i * 300000, sgv: 100 + i % 20, type: 'sgv'}));
    const response = await request(app).post('/entries').send(batch).expect(200);
    assert.equal(response.body.length, 10000);
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.writes[0].ops.map(op => op.updateOne.update.$set.date), batch.map(row => row.date));
    await request(app).post('/entries').send([...batch, batch[0]]).expect(400);
    assert.equal(state.writes.length, 1, 'Oversized batch must not reach storage');
  });
  it('reports ordered partial-batch failures without retrying the batch', async function () {
    const {app, state} = fixture();
    state.failure = Object.assign(new Error('Owned partial batch failure'), {code: 11000, result: {upsertedCount: 1}});
    const response = await request(app).post('/entries').send(rows).expect(500);
    assert.equal(response.body.message, 'Mongo Error');
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.writes[0].options, {ordered: true});
  });
  for (const failure of [false, true]) {
    it('calls the writable persistence callback once on ' + (failure ? 'failure' : 'success'), async function () {
      const {entries, state} = fixture();
      if (failure) state.failure = new Error('Owned storage failure');
      let calls = 0;
      const result = await new Promise(resolve => {
        const sink = entries.persist((error, result) => {calls++; resolve({error, result});});
        rows.forEach(row => sink.write(structuredClone(row)));
        sink.end();
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(state.writes.length, 1);
      assert.equal(Boolean(result.error), failure);
      assert.deepEqual(result.result.map(row => row.sgv), [100, 110]);
    });
  }
  it('reports destruction before end once without writing the partial input', async function () {
    const {entries, state} = fixture();
    let calls = 0;
    const result = await new Promise(resolve => {
      const sink = entries.persist((error, result) => {calls++; resolve({error, result});});
      sink.write(structuredClone(rows[0])); sink.destroy(); sink.destroy();
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(result.error.message, /destroyed before end/);
    assert.equal(calls, 1);
    assert.equal(result.result.length, 1);
    assert.equal(state.writes.length, 0);
  });
  it('keeps the map stream as an ordered identity transform', async function () {
    const {entries} = fixture(), received = [];
    await new Promise((resolve, reject) => {
      const stream = entries.map();
      stream.on('data', row => received.push(row)); stream.on('error', reject); stream.on('end', resolve);
      rows.forEach(row => stream.write(row)); stream.end();
    });
    assert.deepEqual(received, rows);
    assert.equal(received[0], rows[0]);
  });

});
