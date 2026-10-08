'use strict';

const assert = require('assert');
const express = require('express');
const request = require('supertest');
const query = require('../lib/server/query');
const runWithCallback = require('../lib/storage/run-with-callback');

describe('Treatment API query errors', function () {
  let app;
  let ctx;
  let storageError;
  let lastQuery;

  beforeEach(function () {
    app = express();
    storageError = null;
    lastQuery = null;
    const env = { settings: {} };
    ctx = {
      authorization: { isPermitted: () => (req, res, next) => next() },
      cache: { treatments: [] },
      treatments: {
        list: (params, callback) => runWithCallback(function () {
          lastQuery = query(params, { dateField: 'created_at', walker: {} });
          if (storageError) { throw storageError; }
          return [];
        }, callback)
      }
    };
    app.use('/api/v1', require('../lib/api/treatments')(app,
      require('../lib/middleware')(env), ctx, env));
  });

  it('returns JSON for rejected date queries and continues serving requests', async function () {
    const invalidDate = '2026-99-05T00:00:00Z';
    await request(app)
      .get('/api/v1/treatments?count=1&find[created_at][$gte]=' + invalidDate)
      .expect('Content-Type', /json/)
      .expect(500, {
        status: 500,
        message: 'Query Error',
        description: 'Cannot parse ' + invalidDate + ' as a valid ISO-8601 date'
      });
    await request(app).get('/api/v1/treatments').expect(200, []);
  });

  [new Error('Database unavailable'), 'Database unavailable'].forEach(function (error) {
    it('handles a rejected query with ' + (error instanceof Error ? 'an Error' : 'a string'), async function () {
      storageError = error;
      await request(app).get('/api/v1/treatments').expect(500, {
        status: 500, message: 'Query Error', description: 'Database unavailable'
      });
    });
  });

  it('accepts the reported URL-encoded space separator', async function () {
    await request(app)
      .get('/api/v1/treatments?count=1&find[created_at][$gte]=2026-09-05%2000:00:00-04:00')
      .expect(200, []);
    assert.strictEqual(lastQuery.created_at.$gte, '2026-09-05T04:00:00.000Z');
  });

  it('repairs an unescaped positive offset after a space separator', async function () {
    await request(app)
      .get('/api/v1/treatments?count=1&find[created_at][$gte]=2026-09-05%2000:00:00+02:00')
      .expect(200, []);
    assert.strictEqual(lastQuery.created_at.$gte, '2026-09-04T22:00:00.000Z');
  });

  it('preserves cached treatment normalization and conditional responses', async function () {
    ctx.cache.treatments = [{ created_at: '2026-09-05T00:00:00.000Z', carbs: '10', insulin: '2' }];
    await request(app).get('/api/v1/treatments?count=1')
      .expect('Last-Modified', 'Sat, 05 Sep 2026 00:00:00 GMT')
      .expect(200, [{ created_at: '2026-09-05T00:00:00.000Z', carbs: 10, insulin: 2 }]);
    await request(app).get('/api/v1/treatments?count=1')
      .set('If-Modified-Since', 'Sat, 05 Sep 2026 00:00:00 GMT').expect(304);
    assert.strictEqual(lastQuery, null);
  });
});
