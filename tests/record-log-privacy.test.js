'use strict';

// The server logs a summary of a write, not the record, unless DEBUG_LOGGING
// is on (BF-193).
//
// The realtime socket's dbAdd, dbUpdate, dbUpdateUnset and dbRemove handlers
// logged the whole message, and the v1 treatments routes logged every record
// they stored, so glucose, insulin, carbs and notes reached the server log on
// every write. Now each of these lines is a summary (operation, collection,
// client id, record reference, eventType, item count), and the record is
// appended only when DEBUG_LOGGING is on. A refused socket write may come from
// a caller that is not authenticated: its line is bounded and redacted even
// with debugging on.

const http = require('http');
const util = require('util');
const request = require('supertest');
const ioClient = require('socket.io-client');
require('should');

const logPrivacy = require('../lib/server/log-privacy');

describe('the server log holds a summary of a write, not the record (BF-193)', function () {
  this.timeout(15000);
  const self = this;

  const API_SECRET_HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  const MARKER = 'SENTINEL-BF193';
  // A carbs value no other test or default uses. Synthetic values only.
  const CARBS = 87.654;
  const CARBS_TEXT = '87.654';
  const CREDENTIAL = 'bf193-credential-not-for-logs';
  const SUBJECT = 'bf193-read-only';

  // Everything console.log, warn, info, error and debug print while fn runs.
  async function captured (fn) {
    const lines = [];
    const saved = {};
    ['log', 'warn', 'info', 'error', 'debug'].forEach(function (name) {
      saved[name] = console[name];
      console[name] = function () {
        lines.push(Array.prototype.map.call(arguments, function (a) {
          return typeof a === 'string' ? a : util.inspect(a, { depth: 5 });
        }).join(' '));
      };
    });
    try {
      await fn();
    } finally {
      Object.keys(saved).forEach(function (name) { console[name] = saved[name]; });
    }
    return lines;
  }

  function treatment (tag, minute) {
    return {
      eventType: 'Carb Correction'
      , created_at: new Date(Date.UTC(2021, 7, 1, 12, minute)).toISOString()
      , carbs: CARBS
      , notes: MARKER + ' ' + tag
      , enteredBy: MARKER
    };
  }

  function emit (socket, event, message) {
    return new Promise(function (resolve) { socket.emit(event, message, resolve); });
  }

  function connect (server) {
    return new Promise(function (resolve, reject) {
      const socket = ioClient('http://localhost:' + server.address().port, {
        reconnection: false, transports: ['websocket']
      });
      socket.on('connect', function () { resolve(socket); });
      socket.on('connect_error', reject);
    });
  }

  // A socket server and an API on the same booted context, with DEBUG_LOGGING
  // as given.
  async function variant (debug) {
    const env = Object.assign({}, self.env, { debug: { minify: false, logging: debug } });
    const app = require('express')();
    require('../lib/middleware/configure-request')(app);
    app.enable('api');
    app.use('/api', require('../lib/api/')(env, self.ctx));
    const server = http.createServer();
    require('../lib/server/websocket')(env, self.ctx, server);
    await new Promise(function (resolve) { server.listen(0, 'localhost', resolve); });
    const writer = await connect(server);
    const auth = await emit(writer, 'authorize', { secret: API_SECRET_HASH });
    auth.write.should.equal(true);
    return { app, server, writer };
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    require('../lib/server/bootevent')(self.env, require('../lib/language')()).boot(async function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      try {
        // A read-only subject: its socket is authorized, and refused writes.
        const storage = ctx.authorization.storage;
        await new Promise(function (resolve, reject) {
          storage.createSubject({ name: SUBJECT, roles: ['readable'], notes: '' }, function (err) {
            return err ? reject(err) : resolve();
          });
        });
        self.readOnlyToken = storage.subjects.find(function (s) { return s.name === SUBJECT; }).accessToken;
        self.off = await variant(false);
        self.on = await variant(true);
        done();
      } catch (err) {
        done(err);
      }
    });
  });

  after(async function () {
    for (const v of [self.off, self.on]) {
      if (!v) continue;
      v.writer.disconnect();
      await new Promise(function (resolve) { v.server.close(resolve); });
    }
    await self.ctx.store.collection(self.env.treatments_collection).deleteMany({ enteredBy: MARKER });
    await self.ctx.store.collection(self.env.authentication_collections_prefix + 'subjects').deleteMany({ name: SUBJECT });
    self.ctx.bus.teardown();
  });

  // dbAdd, dbUpdate, dbUpdateUnset and dbRemove of one treatment; returns
  // the captured lines and the stored _id.
  async function socketWrites (socket, tag) {
    let id;
    const lines = await captured(async function () {
      const added = await emit(socket, 'dbAdd', { collection: 'treatments', data: treatment(tag, 1) });
      id = String(added[0]._id);
      (await emit(socket, 'dbUpdate', {
        collection: 'treatments', _id: id, data: { notes: MARKER + ' updated', carbs: CARBS }
      })).result.should.equal('success');
      (await emit(socket, 'dbUpdateUnset', {
        collection: 'treatments', _id: id, data: { enteredBy: 1 }
      })).result.should.equal('success');
      (await emit(socket, 'dbRemove', { collection: 'treatments', _id: id })).result.should.equal('success');
    });
    return { lines, id };
  }

  function lineFor (lines, op) {
    return lines.filter(function (line) { return line.includes(op + ' collection=treatments'); });
  }

  it('socket writes log a summary and no record values with DEBUG_LOGGING off', async function () {
    const { lines, id } = await socketWrites(self.off.writer, 'socket-off');
    const log = lines.join('\n');
    log.should.not.containEql(MARKER);
    log.should.not.containEql(CARBS_TEXT);
    // The summary is still there: one line per operation, with the reference.
    lineFor(lines, 'dbAdd').length.should.equal(1);
    lineFor(lines, 'dbAdd')[0].should.containEql('eventType=Carb Correction');
    lineFor(lines, 'dbAdd')[0].should.containEql('client=');
    lineFor(lines, 'dbAdd')[0].should.containEql('ref=2021-08-01T12:01:00.000Z');
    ['dbUpdate', 'dbUpdateUnset', 'dbRemove'].forEach(function (op) {
      lineFor(lines, op).length.should.equal(1, op);
      lineFor(lines, op)[0].should.containEql('ref=' + id);
    });
  });

  it('socket writes log the record with DEBUG_LOGGING on (control)', async function () {
    const { lines } = await socketWrites(self.on.writer, 'socket-on');
    lineFor(lines, 'dbAdd')[0].should.containEql(MARKER + ' socket-on');
    lineFor(lines, 'dbAdd')[0].should.containEql(CARBS_TEXT);
    lineFor(lines, 'dbUpdate')[0].should.containEql(MARKER + ' updated');
    lineFor(lines, 'dbUpdateUnset')[0].should.containEql('enteredBy');
  });

  async function v1Writes (app, tag) {
    return (await captured(async function () {
      const posted = await request(app).post('/api/treatments/').set('api-secret', API_SECRET_HASH)
        .send(treatment(tag, 2)).expect(200);
      const stored = posted.body[0];
      stored.notes = MARKER + ' ' + tag + ' put';
      await request(app).put('/api/treatments/').set('api-secret', API_SECRET_HASH)
        .send(stored).expect(200);
    })).join('\n');
  }

  it('v1 treatments POST and PUT log a summary and no record values with DEBUG_LOGGING off', async function () {
    const log = await v1Writes(self.off.app, 'v1-off');
    log.should.not.containEql(MARKER);
    log.should.not.containEql(CARBS_TEXT);
    log.should.containEql('REST API treatment created collection=treatments items=1');
    log.should.match(/Treatment saved collection=treatments ref=[0-9a-f]{24} eventType=Carb Correction/);
  });

  it('v1 treatments POST and PUT log the record with DEBUG_LOGGING on (control)', async function () {
    const log = await v1Writes(self.on.app, 'v1-on');
    log.should.containEql(MARKER + ' v1-on');
    log.should.containEql(MARKER + ' v1-on put');
    log.should.containEql(CARBS_TEXT);
  });

  // An unauthenticated socket and a read-only one each send an oversized
  // write carrying a credential: the anonymous one in credential fields, the
  // read-only one pastes its own access token into a note.
  async function refusals (server) {
    const anonymous = await connect(server);
    const readOnly = await connect(server);
    try {
      (await emit(readOnly, 'authorize', { secret: self.readOnlyToken })).write.should.equal(false);
      return await captured(async function () {
        const big = MARKER + ' refused ' + 'x'.repeat(50000);
        (await emit(anonymous, 'dbAdd', {
          collection: 'treatments', secret: CREDENTIAL, data: { eventType: 'Note', token: CREDENTIAL, notes: big }
        })).result.should.equal('Not authorized');
        (await emit(readOnly, 'dbAdd', {
          collection: 'treatments', data: { eventType: 'Note', notes: 'pasted ' + self.readOnlyToken + '\n' + big }
        })).result.should.equal('Not permitted');
        (await emit(anonymous, 'dbUpdate', 'not a document ' + MARKER)).result.should.equal('Invalid request');
      });
    } finally {
      anonymous.disconnect();
      readOnly.disconnect();
    }
  }

  function refusalLines (lines) {
    return lines.filter(function (line) { return /Not authorized|Not permitted|Invalid request/.test(line); });
  }

  it('a refused socket write logs a summary only with DEBUG_LOGGING off', async function () {
    const lines = refusalLines(await refusals(self.off.server));
    lines.length.should.equal(3);
    const log = lines.join('\n');
    log.should.not.containEql(MARKER);
    log.should.not.containEql(CREDENTIAL);
    log.should.not.containEql(self.readOnlyToken);
    lines[0].should.containEql('dbAdd collection=treatments');
    lines[2].should.containEql('record=string');
  });

  it('a refused socket write is bounded and redacted with DEBUG_LOGGING on', async function () {
    const lines = refusalLines(await refusals(self.on.server));
    lines.length.should.equal(3);
    lines.forEach(function (line) {
      // The fixed prefix of each refusal line is under 64 characters.
      line.length.should.be.belowOrEqual(logPrivacy.LOG_LIMIT + 64);
      line.should.not.containEql(CREDENTIAL);
      line.should.not.containEql(self.readOnlyToken);
    });
    lines[0].should.containEql(MARKER + ' refused');
    lines[0].should.containEql('[truncated]');
    lines[0].should.containEql('"secret":"[REDACTED]"');
    lines[0].should.containEql('"token":"[REDACTED]"');
    // The note that carries the socket's own credential is redacted whole.
    lines[1].should.containEql('payload: [REDACTED]');
    lines[2].should.containEql('not a document ' + MARKER);
  });

  it('recordForLog summarizes arrays by count and bounds client-controlled fields', function () {
    logPrivacy.recordForLog([{ carbs: CARBS }, { carbs: CARBS }], { op: 'x', collection: 'treatments' })
      .should.equal('x collection=treatments items=2');
    const line = logPrivacy.recordForLog({ _id: 'a\nb'.repeat(200), carbs: CARBS }, { collection: 'c\r\n'.repeat(100) });
    line.should.not.match(/[\r\n]/);
    line.should.not.containEql(CARBS_TEXT);
    line.length.should.be.below(300);
  });
});
