'use strict';

// find[x][$type] and find[x][$exists] end to end: query string, query.js,
// the v1 module's read through the storage interface, MongoDB, and back.
//
// No test pinned these before: lib/server/query.js reads `find[sgv][$type]=2`
// as the number 2 (#8737) and `$exists=false` as the boolean, and the storage
// interface has to carry both operands to MongoDB unchanged. Removing either
// left the rest of the suite green.

const assert = require('node:assert/strict');
const request = require('supertest');
const language = require('../lib/language')();

describe('API v1 find[...][$type] and find[...][$exists] over HTTP', function ( ) {
  this.timeout(15000);
  const known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  const marker = 'type-exists-' + process.pid + '-' + Date.now();
  let app, ctx, env, saved;

  before(function (done) {
    // tests/env.test.js deletes INSECURE_USE_HTTP; without it every request
    // here is redirected to HTTPS (307), whichever order the files run in.
    saved = { API_SECRET: process.env.API_SECRET, INSECURE_USE_HTTP: process.env.INSECURE_USE_HTTP };
    process.env.API_SECRET = 'this is my long pass phrase';
    process.env.INSECURE_USE_HTTP = 'true';
    env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'readable';
    env.settings.enable = ['careportal', 'api'];
    app = require('express')();
    require('../lib/middleware/configure-request')(app);
    app.enable('api');
    require('../lib/server/bootevent')(env, language).boot(async function booted (booted) {
      ctx = booted;
      ctx.ddata = require('../lib/data/ddata')();
      app.use('/api/v1', require('../lib/api/')(env, ctx));
      try {
        const now = Date.now();
        await ctx.store.collection(env.entries_collection).insertMany([
          { label: 'A', type: 'sgv', sgv: 100, date: now - 60000 }
          , { label: 'B', type: 'sgv', sgv: '120', date: now - 120000 }
          , { label: 'C', type: 'mbg', mbg: 90, date: now - 180000 }
          , { label: 'D', type: 'sgv', sgv: 140, mbg: 95, date: now - 240000 }
        ].map(d => Object.assign(d, { device: marker, dateString: new Date(d.date).toISOString() })));
        await ctx.store.collection(env.treatments_collection).insertMany([
          { label: 'T1', eventType: 'Note', carbs: 10 }
          , { label: 'T2', eventType: 'Note', carbs: '15' }
          , { label: 'T3', eventType: 'Note' }
        ].map((d, i) => Object.assign(d, { enteredBy: marker, created_at: new Date(now - (i + 1) * 60000).toISOString() })));
        done();
      } catch (err) { done(err); }
    });
  });

  after(async function ( ) {
    try {
      if (ctx) {
        await ctx.store.collection(env.entries_collection).deleteMany({ device: marker });
        await ctx.store.collection(env.treatments_collection).deleteMany({ enteredBy: marker });
      }
    } finally {
      for (const [k, v] of Object.entries(saved || { })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  async function labels (path, query) {
    const res = await request(app).get(path + '?count=100&' + query).set('api-secret', known).expect(200);
    return res.body.map(d => d.label);
  }
  const entries = q => labels('/api/v1/entries.json', 'find[device]=' + marker + '&' + q);
  const treatments = q => labels('/api/v1/treatments.json', 'find[enteredBy]=' + marker + '&' + q);

  it('selects by BSON type code and alias', async function ( ) {
    // `2` must reach MongoDB as the number 2 (string); as the string "2" mongod
    // answers "Unknown type name alias".
    assert.deepEqual(await entries('find[sgv][$type]=2'), ['B']);
    assert.deepEqual(await entries('find[sgv][$type]=string'), ['B']);
    assert.deepEqual(await entries('find[sgv][$type]=number'), ['A', 'D']);
    assert.deepEqual(await treatments('find[carbs][$type]=2'), ['T2']);
  });

  it('selects by key presence, reading true/false/1/0 and leaving \'\' to MongoDB', async function ( ) {
    assert.deepEqual(await entries('find[mbg][$exists]=true'), ['C', 'D']);
    assert.deepEqual(await entries('find[mbg][$exists]=false'), ['A', 'B']);
    assert.deepEqual(await entries('find[sgv][$exists]=0'), ['C']);
    assert.deepEqual(await entries('find[sgv][$exists]=1'), ['A', 'B', 'D']);
    // A valueless $exists is '' and MongoDB reads '' as presence.
    assert.deepEqual(await entries('find[mbg][$exists]'), ['C', 'D']);
    assert.deepEqual(await treatments('find[carbs][$exists]=false'), ['T3']);
  });
});
