'use strict';

// Compat card A, option (i) (maintainer 2026-10-31): with WRITE_IDENTIFIER
// unset, API v3 refuses what 15.0.9's API v3 refused, and only that: an
// `identifier` that is a whitespace-only string ("   ") or a number is
// answered 400 (Bad or missing identifier field) and nothing is stored. Every
// other identifier slice 2 (ID-Q6) treats as absent stays lenient on API v3:
// a placeholder (undefined, null, invalid, NaN, unknown), the empty string,
// JSON null, an over-length string, or another non-string value is dropped and
// an identifier computed, as #8879 does (15.0.9 accepted all of them). API v1,
// the socket and in-process callers do not change: the value is treated as
// absent there.
//
// The setting: unset gives this per-class API v3 default; `lenient` makes
// every path lenient (API v3 accepts "   " and a number, as #8879 did);
// `strict` is as before (API v3 and the socket refuse every invalid class;
// API v1 and in-process treat it as absent, ID-STRICT-V1).
//
// Synthetic values only; every record is dated in May 2019.

const request = require('supertest');
require('should');
const assert = require('node:assert/strict');

const known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
const TAG = 'identifier-default-test';
const T_MS = Date.parse('2019-05-13T07:40:00.000Z');
const at = (minutes) => new Date(T_MS + minutes * 60000).toISOString();

function quiet (work) {
  const warn = console.warn;
  console.warn = function () { };
  return Promise.resolve().then(work).finally(function () { console.warn = warn; });
}

describe('compat card A, option (i): API v3 refuses a whitespace-only or numeric identifier by default', function ( ) {
  this.timeout(30000);
  const self = this;
  const instance = require('./fixtures/api3/instance');
  const authSubject = require('./fixtures/api3/authSubject');
  const io = require('socket.io-client');
  const writeSettings = require('../lib/server/write-settings');

  const COLLECTIONS = ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'];
  const col = (name) => self.instance.ctx.store.collection(self.env[name + '_collection'] || name);
  const stored = (name) => col(name).find({ app: TAG }).toArray();

  function body (name, minutes, fields) {
    const created = at(minutes);
    const shape = {
      treatments: { eventType: 'Correction Bolus', insulin: 1, created_at: created }
      , entries: { type: 'sgv', sgv: 120, dateString: created }
      , devicestatus: { created_at: created, uploaderBattery: 50 }
      , profile: { defaultProfile: TAG, startDate: created, store: { [TAG]: { dia: 3 } } }
      , food: { type: 'food', name: TAG, carbs: 10 }
      , settings: { value: 1 }
    }[name];
    return Object.assign({ date: Date.parse(created), utcOffset: 0, device: 'app-a', app: TAG, enteredBy: TAG }, shape, fields);
  }

  function v3 (name, doc) {
    return quiet(() => request(self.instance.app).post('/api/v3/' + name).set('Authorization', 'Bearer ' + self.jwt).send(doc));
  }

  function v1 (name, doc) {
    return quiet(() => request(self.instance.app).post('/api/v1/' + name + '/').set('api-secret', known).send(doc));
  }

  function emit (event, data) {
    return quiet(() => new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    }));
  }

  // WRITE_IDENTIFIER as env.js parses it: undefined is unset.
  function setMode (value) {
    const parsed = writeSettings.parseIdentifierMode(value);
    assert.equal(parsed.error, undefined);
    self.env.write = Object.freeze(Object.assign({ }, self.env.write, { identifier: parsed.mode }));
  }

  before(async function ( ) {
    delete process.env.WRITE_IDENTIFIER;
    self.instance = await instance.create({ useHttps: false });
    self.env = self.instance.env;
    self.instance.app.use('/api/v1', require('../lib/api/')(self.env, self.instance.ctx));
    self.jwt = (await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app)).jwt.all;
    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      self.socket.on('connect', function ( ) {
        self.socket.emit('authorize', { client: 'test', secret: known }, function (auth) {
          if (!auth || !auth.write || !auth.write_treatment) return reject(new Error('socket not authorized to write'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  beforeEach(async function ( ) {
    setMode(undefined);
    await Promise.all(COLLECTIONS.map((name) => col(name).deleteMany({ app: TAG })));
  });

  after(async function ( ) {
    setMode(undefined);
    if (self.socket) self.socket.close();
    await Promise.all(COLLECTIONS.map((name) => col(name).deleteMany({ app: TAG })));
    self.instance.ctx.bus.teardown();
  });

  it('the setting: unset is its own mode, not lenient', function ( ) {
    assert.equal(self.env.write.identifier, 'default');
    assert.equal(writeSettings.identifierMode(self.env), 'default');
  });

  COLLECTIONS.forEach(function (name) {
    [['whitespace', '   '], ['a number', T_MS]].forEach(function ([label, value]) {
      it(name + ': ' + label + ' is refused with 400 and nothing is stored', async function ( ) {
        const res = await v3(name, body(name, 0, { identifier: value }));
        res.status.should.equal(400);
        res.body.message.should.equal('Bad or missing identifier field');
        (await stored(name)).length.should.equal(0);
      });
    });
  });

  // 15.0.9 accepted these on API v3; they stay lenient (slice 2, ID-Q6).
  [['the empty string', ''], ['JSON null', null], ['a placeholder', 'undefined'], ['a placeholder', 'NaN']
    , ['an over-length string', 'x'.repeat(257)], ['an object', { $ne: null }], ['a boolean', true]].forEach(function ([label, value]) {
    it('treatments: ' + label + ' is treated as absent and an identifier computed (201)', async function ( ) {
      const res = await v3('treatments', body('treatments', 0, { identifier: value }));
      res.status.should.equal(201);
      const docs = await stored('treatments');
      docs.length.should.equal(1);
      docs[0].identifier.should.be.a.String();
      docs[0].identifier.should.not.equal(value);
    });
  });

  it('API v1: whitespace and a number are treated as absent, not refused', async function ( ) {
    (await v1('treatments', body('treatments', 0, { identifier: '   ' }))).status.should.equal(200);
    (await v1('treatments', body('treatments', 5, { identifier: T_MS, insulin: 2 }))).status.should.equal(200);
    const docs = await stored('treatments');
    docs.length.should.equal(2);
    docs.forEach((d) => assert.equal(Object.prototype.hasOwnProperty.call(d, 'identifier'), false));
  });

  it('the socket: whitespace and a number are treated as absent, not refused', async function ( ) {
    const first = await emit('dbAdd', { collection: 'treatments', data: body('treatments', 0, { identifier: '   ' }) });
    const second = await emit('dbAdd', { collection: 'devicestatus', data: body('devicestatus', 0, { identifier: T_MS }) });
    first.length.should.equal(1);
    assert.equal(first[0].refused, undefined);
    second.length.should.equal(1);
    assert.equal(second[0].refused, undefined);
    (await stored('treatments')).forEach((d) => assert.equal(Object.prototype.hasOwnProperty.call(d, 'identifier'), false));
    (await stored('devicestatus')).forEach((d) => assert.equal(Object.prototype.hasOwnProperty.call(d, 'identifier'), false));
  });

  it('in-process: whitespace and a number are treated as absent, not refused', async function ( ) {
    const create = (docs) => new Promise((resolve, reject) => self.instance.ctx.treatments.create(docs
      , (err, result) => err ? reject(err) : resolve(result)));
    await quiet(() => create([body('treatments', 0, { identifier: '   ' }), body('treatments', 5, { identifier: T_MS, insulin: 2 })]));
    const docs = await stored('treatments');
    docs.length.should.equal(2);
    docs.forEach((d) => assert.equal(Object.prototype.hasOwnProperty.call(d, 'identifier'), false));
  });

  it('WRITE_IDENTIFIER=lenient: API v3 accepts whitespace and a number, as #8879 did', async function ( ) {
    setMode('lenient');
    (await v3('treatments', body('treatments', 0, { identifier: '   ' }))).status.should.equal(201);
    (await v3('entries', body('entries', 0, { identifier: T_MS }))).status.should.equal(201);
    (await stored('treatments')).length.should.equal(1);
    (await stored('entries')).length.should.equal(1);
  });

  it('WRITE_IDENTIFIER=strict: API v3 refuses a placeholder too, as before', async function ( ) {
    setMode('strict');
    const res = await v3('treatments', body('treatments', 0, { identifier: 'undefined' }));
    res.status.should.equal(400);
    (await stored('treatments')).length.should.equal(0);
  });
});
