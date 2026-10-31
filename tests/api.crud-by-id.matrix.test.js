/* eslint require-atomic-updates: 0 */
'use strict';

// Create, read, update and delete by `_id`, for every collection and every
// form an `_id` can be stored in, through API v1, API v3 and the websocket.
//
// Each cell seeds (or creates) one record, drives one operation by that
// record's id, then reads MongoDB to see what is stored. The expected outcome
// of each cell is written down in EXPECT below, including the places where
// collections deliberately differ (a non-hex `_id` is moved to `identifier`
// by treatments and entries, refused with 400 by the other v1 routes, and kept
// as given by the websocket).
//
// Stored forms:
//   oid    the `_id` is an ObjectId (asked for by its lower-case hex)
//   oidU   the `_id` is an ObjectId, asked for by its upper-case hex
//   lower  the `_id` is the lower-case 24-hex string (v1 before the fix)
//   upper  the `_id` is the upper-case 24-hex string
//   uuid   the `_id` is a UUID string (treatments and entries before 15.0.7)
//
// Set CRUD_MATRIX_OUT to a file path to write every cell's expected and
// observed outcome as JSON.
//
// Synthetic records only.

var should = require('should');
var MMOL_TO_MGDL = require('../lib/constants.json').MMOL_TO_MGDL;
var ObjectID = require('mongodb').ObjectId;
var io = require('socket.io-client');
var fs = require('fs');

var FORMS = ['oid', 'oidU', 'lower', 'upper', 'uuid'];
var SENT_FORMS = ['lower', 'upper', 'uuid'];
var KNOWN = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

var COLS = {
  entries: { code: 'e1', v1: true, v1find: true, v1get: true, v1put: false, v3: true, ws: true }
  , treatments: { code: 'b1', v1: true, v1find: true, v1get: false, v1put: true, v3: true, ws: true }
  , devicestatus: { code: 'd1', v1: true, v1find: true, v1get: false, v1put: false, v3: true, ws: true }
  , profile: { code: 'c1', v1: true, v1find: true, v1get: false, v1put: true, v3: true, ws: true }
  , food: { code: 'f1', v1: true, v1find: false, v1get: false, v1put: true, v3: true, ws: true }
  , activity: { code: 'a1', v1: true, v1find: true, v1get: false, v1put: true, v3: false, ws: true }
};

var UUID_COLS = ['entries', 'treatments'];

// ---------------------------------------------------------------------------
// Expected outcomes. Each returns [expected, why] for one cell.
// ---------------------------------------------------------------------------

function isHexForm (form) { return form !== 'uuid'; }


var EXPECT = {
  // POST a new record carrying its own _id.
  'v1 create': function (col, form) {
    if (isHexForm(form)) return ['200 [ObjectId]', 'a 24-hex _id is stored as the ObjectId it names'];
    if (UUID_COLS.indexOf(col) !== -1) return ['200 [ObjectId/ident]', 'REQ-SYNC-072: a UUID _id moves to identifier (UUID_HANDLING on)'];
    return ['400 []', 'v1 route refuses a non-hex _id'];
  }
  // POST the same record again, with the _id it is stored under.
  , 'v1 resend': function (col, form) {
    var stored = (form === 'oid' || form === 'oidU') ? 'ObjectId' : 'string';
    if (!isHexForm(form) && UUID_COLS.indexOf(col) === -1) return ['400 [string]', 'v1 route refuses a non-hex _id'];
    switch (col) {
      case 'entries':
        if (form === 'uuid') return ['200 [string/ident]', 'dedup on sysTime+type updates the stored entry; the UUID moves to identifier'];
        return ['200 [' + stored + ']', 'dedup on sysTime+type updates the stored entry in place, as a POST without _id does'];
      case 'treatments':
        if (form === 'uuid') return ['200 [string/ident]', 'upsert matches the legacy _id=UUID record ($or identifier/_id)'];
        return ['200 [ObjectId]', 'upsert by _id; a string copy is replaced by the ObjectId'];
      case 'devicestatus':
        // CHANGED EXPECTATION (BF-116): was 500, "refused as a duplicate".
        return ['200 [' + stored + ']', 'a re-sent devicestatus _id is answered with the stored record and not stored again, whichever form it is stored in'];
      case 'profile':
        // CHANGED EXPECTATION (BF-166): was 500, "refused as a duplicate".
        return ['200 [' + stored + ']', 'a re-sent profile _id is merged into the stored record (write contract Q1) and not stored again, whichever form it is stored in'];
      default:
        return ['200 [ObjectId]', 'create is an upsert by _id; a string copy is replaced by the ObjectId'];
    }
  }
  // GET ?find[_id]=<id>
  , 'v1 find': function () {
    return ['200 n=1', 'find[_id] matches the record whichever form its _id is stored in'];
  }
  // GET /entries/<id>
  , 'v1 get': function (col, form) {
    if (form === 'uuid') return ['200 n=0', 'GET /entries/:spec takes a 24-hex id; anything else is a model name (use find[_id])'];
    return ['200 n=1', 'GET /entries/<id> finds the entry, in either hex case'];
  }
  // PUT the record with new content and the _id it is stored under.
  , 'v1 update': function (col, form) {
    if (!isHexForm(form) && col !== 'treatments') return ['400 n=1 edited=false', 'v1 route refuses a non-hex _id'];
    return ['200 n=1 edited=true', 'the edit replaces the record, leaving one'];
  }
  // DELETE by id.
  , 'v1 delete': function (col, form) {
    if (form === 'uuid') {
      if (col === 'treatments') return ['200 n=0', 'DELETE /treatments/<uuid> matches the legacy _id=UUID record'];
      if (col === 'entries') return ['200 n=1', 'DELETE /entries/:spec takes a 24-hex id; anything else is a model name (use find[_id])'];
      return ['400 n=1', 'v1 route refuses a non-hex _id'];
    }
    return ['200 n=0', 'DELETE by id removes the record, in either hex case'];
  }
  // API v3 gives a v1 record without identifier the identifier String(_id)
  // (lib/api3/swagger.yaml: used "when reading or addressing these
  // documents"), and its filters match that identifier against _id, 24-hex or
  // not.
  , 'v3 get': function () { return ['200', 'GET by the identifier v3 lists the v1 record under finds it']; }
  , 'v3 put': function (col, form) {
    if (form === 'oidU') return ['400 n=1 edited=false', 'v3 identifiers are immutable strings: a PUT naming an ObjectId record by its upper-case hex would change its identifier'];
    return ['200 n=1 edited=true', 'v3 PUT by identifier replaces the v1 record, leaving one'];
  }
  , 'v3 delete': function () { return ['200 n=0', 'v3 permanent DELETE by identifier removes the v1 record']; }
  , 'v3 resend': function (col) {
    // ID-SIMPLE-MATCH, devicestatus option (b), decided 2026-10-26: a device
    // status re-sent with a stored identifier is acknowledged, not rewritten.
    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 4, ID-Q2): it is merged into
    // the v1 status, as every other collection's re-send is; the third entry is
    // what is observed now, and the cell's title keeps the first.
    if (col === 'devicestatus') return ['200 n=1 edited=false', 'v3 POST with the same identifier deduplicates onto the v1 status (merged, ID-Q2)', '200 n=1 edited=true'];
    return ['200 n=1 edited=true', 'v3 POST with the same identifier deduplicates onto the v1 record'];
  }
  // websocket dbAdd of a new record carrying its own _id
  , 'ws create': function (col, form) {
    if (isHexForm(form)) return ['[ObjectId]', 'a 24-hex _id is stored as the ObjectId it names, as v1 does'];
    return ['[string]', 'the websocket keeps a non-hex _id as given (tests/websocket.shape-handling.test.js)'];
  }
  // websocket dbAdd of the same record again, with the _id it is stored under
  , 'ws resend': function () { return ['n=1', 'a re-sent record does not add a second copy']; }
  , 'ws update': function () { return ['success n=1 edited=true', 'dbUpdate edits the record whichever form its _id is stored in']; }
  , 'ws remove': function () { return ['success n=0', 'dbRemove removes the record whichever form its _id is stored in']; }
};

describe('CRUD by _id matrix: v1, v3 and websocket, every collection and stored _id form', function () {
  var self = this;
  var instance = require('./fixtures/api3/instance');
  var authSubject = require('./fixtures/api3/authSubject');
  var results = [];
  var counter = 0;
  var commits = [];

  this.timeout(30000);

  // ids and times -------------------------------------------------------------

  function nextN () { counter += 1; return counter; }

  function hexFor (col, n) {
    // contains a-f so the upper- and lower-case spellings differ
    return (COLS[col].code + 'c0abcdef' + n.toString(16).padStart(14, '0')).slice(0, 24);
  }

  function uuidFor (col, n) {
    return '0000' + COLS[col].code + '00-0000-4000-8000-' + n.toString(16).padStart(12, '0');
  }

  // stored _id and the spelling a client uses to ask for it
  function idFor (col, form, n) {
    var hex = hexFor(col, n);
    switch (form) {
      case 'oid': return { stored: new ObjectID(hex), asked: hex, hex: hex };
      case 'oidU': return { stored: new ObjectID(hex), asked: hex.toUpperCase(), hex: hex };
      case 'lower': return { stored: hex, asked: hex, hex: hex };
      case 'upper': return { stored: hex.toUpperCase(), asked: hex.toUpperCase(), hex: hex };
      default: var u = uuidFor(col, n); return { stored: u, asked: u, hex: null };
    }
  }

  function when (n) { return Date.UTC(2021, 5, 1) + n * 60000; }

  // records ---------------------------------------------------------------

  // The fields a record of each collection needs for every API to accept it.
  function body (col, n, marker) {
    var t = when(n);
    var iso = new Date(t).toISOString();
    var common = { date: t, utcOffset: 0, app: 'crud-matrix', crud: marker || 'original' };
    switch (col) {
      case 'entries':
        return Object.assign({ type: 'sgv', sgv: 100 + (n % 200), dateString: iso, device: 'crud-matrix' }, common);
      case 'treatments':
        return Object.assign({ eventType: 'Note', notes: 'crud-matrix', created_at: iso }, common);
      case 'devicestatus':
        return Object.assign({ device: 'crud-matrix', created_at: iso, uploaderBattery: 50 }, common);
      case 'profile':
        return Object.assign({
          defaultProfile: 'Default'
          , store: { Default: { dia: 3, carbratio: [{ time: '00:00', value: 30, timeAsSeconds: 0 }], sens: [{ time: '00:00', value: 100, timeAsSeconds: 0 }], basal: [{ time: '00:00', value: 0.1, timeAsSeconds: 0 }], target_low: [{ time: '00:00', value: 100, timeAsSeconds: 0 }], target_high: [{ time: '00:00', value: 100, timeAsSeconds: 0 }], timezone: 'UTC', units: 'mg/dl' } }
          , startDate: iso
          , units: 'mg/dl'
        }, common);
      case 'food':
        return Object.assign({ type: 'food', category: 'crud-matrix', name: 'food ' + n, portion: 1, unit: 'g', carbs: 10 }, common);
      case 'activity':
        return Object.assign({ created_at: iso, heartrate: 90, steps: n, activitylevel: 'crud-matrix' }, common);
    }
  }

  // What v1 storage would hold for a record inserted before the fix.
  function seedDoc (col, n, id) {
    var doc = body(col, n);
    doc._id = id.stored;
    if (col === 'entries') doc.sysTime = doc.dateString;
    return doc;
  }

  function collection (col) {
    return self.instance.ctx.store.collection(self.env[col + '_collection']);
  }

  function seed (col, n, id) {
    return collection(col).insertOne(seedDoc(col, n, id));
  }

  // Every stored record for this id: by any _id form, or by identifier.
  async function storedFor (col, id) {
    var forms = id.hex ? [new ObjectID(id.hex), id.hex, id.hex.toUpperCase()] : [id.asked];
    var idents = id.hex ? [id.hex, id.hex.toUpperCase()] : [id.asked];
    return collection(col).find({ $or: [{ _id: { $in: forms } }, { identifier: { $in: idents } }] }).toArray();
  }

  function describeDocs (docs, asked) {
    return '[' + docs.map(function (d) {
      var t = typeof d._id === 'string' ? 'string' : 'ObjectId';
      return t + (d.identifier && String(d.identifier).toLowerCase() === String(asked).toLowerCase() ? '/ident' : '');
    }).sort().join(',') + ']';
  }

  function allEdited (docs) {
    return docs.length > 0 && docs.every(function (d) { return d.crud === 'edited'; });
  }

  // transports -------------------------------------------------------------

  function v1 (method, url) {
    return self.instance[method](url).set('api-secret', KNOWN).set('Accept', 'application/json');
  }

  function v1Base (col) {
    return '/api/v1/' + col + '/';
  }

  function v1FindUrl (col, asked) {
    var path = col === 'profile' ? '/api/v1/profiles/' : '/api/v1/' + col + '/';
    return path + '?find[_id]=' + encodeURIComponent(asked) + '&count=10';
  }

  function wsEmit (event, data) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // cells -------------------------------------------------------------------

  function cell (api, op, col, form, run) {
    var key = api + ' ' + op;
    var exp = EXPECT[key](col, form);
    var title = exp[0];
    if (exp[2] !== undefined) exp = [exp[2], exp[1]];
    it(key + ' | ' + col + ' | ' + form + ' -> ' + title, async function () {
      var observed;
      var beforeCommits = commits.length;
      try {
        observed = await run();
      } catch (err) {
        observed = 'threw: ' + (err && err.message ? err.message : String(err));
      }
      results.push({ api: api, op: op, col: col, form: form, expected: exp[0], observed: observed, why: exp[1] });
      should(observed).equal(exp[0]);
      // G2: the real transport must cross the common persistence boundary.
      // No-op resends keep their historical behavior and need not emit.
      var changes = ['create', 'put', 'update', 'delete', 'remove'].indexOf(op) !== -1;
      if (changes && !/^400/.test(observed)
        && !(op === 'delete' && /n=1$/.test(observed))) {
        var source = api === 'ws' ? 'socket' : api === 'v1' ? 'v1/internal' : 'v3';
        should(commits.slice(beforeCommits).some(event => event.collection === col && event.source === source))
          .equal(true, 'write bypassed the shared boundary: ' + key + ' ' + col);
      }
    });
  }

  before(async function () {
    self.instance = await instance.create({ useHttps: false });
    self.env = self.instance.env;
    self.instance.ctx.bus.on('storage-write-committed', event => commits.push(event));
    self.instance.app.use('/api/v1', require('../lib/api/')(self.env, self.instance.ctx));
    var authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;

    await new Promise(function (resolve, reject) {
      self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
      self.socket.on('connect', function () {
        self.socket.emit('authorize', { client: 'test', secret: KNOWN }, function (auth) {
          if (!auth || !auth.write || !auth.write_treatment) return reject(new Error('websocket not authorized to write'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });

    await Promise.all(Object.keys(COLS).map(function (col) {
      return collection(col).deleteMany({ app: 'crud-matrix' });
    }));
  });

  after(async function () {
    if (self.socket) self.socket.disconnect();
    if (process.env.CRUD_MATRIX_OUT) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.writeFileSync(process.env.CRUD_MATRIX_OUT, JSON.stringify(results, null, 1));
    }
    await Promise.all(Object.keys(COLS).map(function (col) {
      return collection(col).deleteMany({ app: 'crud-matrix' });
    }));
    self.instance.ctx.bus.teardown();
  });

  // ---- API v1 --------------------------------------------------------------

  Object.keys(COLS).forEach(function (col) {
    var c = COLS[col];

    describe('v1 ' + col, function () {

      SENT_FORMS.forEach(function (form) {
        cell('v1', 'create', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          var res = await v1('post', v1Base(col)).send(Object.assign(body(col, n), { _id: id.asked }));
          return res.status + ' ' + describeDocs(await storedFor(col, id), id.asked);
        });
      });

      FORMS.forEach(function (form) {

        cell('v1', 'resend', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var res = await v1('post', v1Base(col)).send(Object.assign(body(col, n, 'edited'), { _id: id.asked }));
          return res.status + ' ' + describeDocs(await storedFor(col, id), id.asked);
        });

        if (c.v1find) {
          cell('v1', 'find', col, form, async function () {
            var n = nextN();
            var id = idFor(col, form, n);
            await seed(col, n, id);
            var res = await v1('get', v1FindUrl(col, id.asked));
            var found = Array.isArray(res.body) ? res.body.filter(function (d) { return d.crud === 'original' && d.app === 'crud-matrix'; }) : [];
            return res.status + ' n=' + found.length;
          });
        }

        if (c.v1get) {
          cell('v1', 'get', col, form, async function () {
            var n = nextN();
            var id = idFor(col, form, n);
            await seed(col, n, id);
            var res = await v1('get', '/api/v1/' + col + '/' + encodeURIComponent(id.asked));
            var found = Array.isArray(res.body) ? res.body.filter(function (d) { return d && d.app === 'crud-matrix' && d.date === when(n); }) : [];
            return res.status + ' n=' + found.length;
          });
        }

        if (c.v1put) {
          cell('v1', 'update', col, form, async function () {
            var n = nextN();
            var id = idFor(col, form, n);
            await seed(col, n, id);
            var res = await v1('put', v1Base(col)).send(Object.assign(body(col, n, 'edited'), { _id: id.asked }));
            var docs = await storedFor(col, id);
            return res.status + ' n=' + docs.length + ' edited=' + allEdited(docs);
          });
        }

        cell('v1', 'delete', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var res = await v1('delete', v1Base(col) + encodeURIComponent(id.asked));
          return res.status + ' n=' + (await storedFor(col, id)).length;
        });
      });
    });
  });

  // ---- API v3 --------------------------------------------------------------

  Object.keys(COLS).filter(function (col) { return COLS[col].v3; }).forEach(function (col) {
    var url = '/api/v3/' + col;

    describe('v3 ' + col, function () {
      FORMS.forEach(function (form) {

        cell('v3', 'get', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var res = await self.instance.get(url + '/' + encodeURIComponent(id.asked), self.jwt.all);
          return String(res.status);
        });

        cell('v3', 'put', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var res = await self.instance.put(url + '/' + encodeURIComponent(id.asked), self.jwt.all).send(body(col, n, 'edited'));
          var docs = await storedFor(col, id);
          return res.status + ' n=' + docs.length + ' edited=' + allEdited(docs);
        });

        cell('v3', 'delete', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var res = await self.instance.delete(url + '/' + encodeURIComponent(id.asked) + '?permanent=true', self.jwt.all);
          return res.status + ' n=' + (await storedFor(col, id)).length;
        });

        cell('v3', 'resend', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var res = await self.instance.post(url, self.jwt.all).send(Object.assign(body(col, n, 'edited'), { identifier: id.asked }));
          var docs = await storedFor(col, id);
          return res.status + ' n=' + docs.length + ' edited=' + allEdited(docs);
        });
      });
    });
  });

  // ---- websocket -------------------------------------------------------------

  Object.keys(COLS).filter(function (col) { return COLS[col].ws; }).forEach(function (col) {

    describe('ws ' + col, function () {

      SENT_FORMS.forEach(function (form) {
        cell('ws', 'create', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await wsEmit('dbAdd', { collection: col, data: Object.assign(body(col, n), { _id: id.asked }) });
          return describeDocs(await storedFor(col, id), id.asked);
        });
      });

      FORMS.forEach(function (form) {

        cell('ws', 'resend', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          await wsEmit('dbAdd', { collection: col, data: Object.assign(body(col, n, 'edited'), { _id: id.asked }) });
          return 'n=' + (await storedFor(col, id)).length;
        });

        cell('ws', 'update', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var reply = await wsEmit('dbUpdate', { collection: col, _id: id.asked, data: { crud: 'edited' } });
          var docs = await storedFor(col, id);
          return (reply && reply.result) + ' n=' + docs.length + ' edited=' + allEdited(docs);
        });

        cell('ws', 'remove', col, form, async function () {
          var n = nextN();
          var id = idFor(col, form, n);
          await seed(col, n, id);
          var reply = await wsEmit('dbRemove', { collection: col, _id: id.asked });
          return (reply && reply.result) + ' n=' + (await storedFor(col, id)).length;
        });
      });
    });
  });
  // ---- internal/plugin callers ---------------------------------------------
  Object.keys(COLS).forEach(function (col) {
    it('internal create and cross-path resend | ' + col, async function () {
      var n = nextN(), id = idFor(col, 'oid', n);
      var before = commits.length;
      var doc = Object.assign(body(col, n), {_id: id.asked});
      await new Promise((resolve, reject) => self.instance.ctx[col].create([doc],
        (err, result) => err ? reject(err) : resolve(result)));
      should(commits.slice(before).some(event => event.collection === col && event.source === 'v1/internal')).equal(true);
      should((await storedFor(col, id)).length).equal(1);
      await v1('post', v1Base(col)).send(Object.assign(body(col, n), {_id: id.asked}));
      should((await storedFor(col, id)).length).equal(1);
    });
  });

  describe('WRITE_VALIDATION across all four paths', function () {
    for (const mode of ['off', 'log', 'reject']) {
      it(mode + ' preserves each reply contract and checks socket writes too', async function () {
        const previous = self.env.writeValidation;
        self.env.writeValidation = mode;
        try {
          for (const source of ['v1', 'v3', 'socket', 'internal']) {
            const n = nextN(), id = idFor('treatments', 'oid', n);
            const doc = Object.assign(body('treatments', n), {
              eventType: 'Temporary Target', duration: 30, targetBottom: 12, targetTop: 6,
              _id: id.asked
            });
            if (source === 'v1') {
              const res = await v1('post', v1Base('treatments')).send(doc);
              should(res.status).equal(mode === 'reject' ? 400 : 200);
            } else if (source === 'v3') {
              delete doc._id;
              doc.identifier = id.asked;
              const res = await self.instance.post('/api/v3/treatments', self.jwt.all).send(doc);
              should(res.status).equal(mode === 'reject' ? 400 : 201);
            } else if (source === 'socket') {
              const res = await wsEmit('dbAdd', {collection: 'treatments', data: doc});
              should(res.length).equal(1);
              if (mode === 'reject') {
                should(res[0].refused.status).equal(400);
                should(res[0]._id).equal(undefined);
              }
            } else {
              const err = await new Promise(resolve => self.instance.ctx.treatments.create([doc], err => resolve(err)));
              should(Boolean(err)).equal(mode === 'reject');
            }
            should((await storedFor('treatments', id)).length).equal(mode === 'reject' ? 0 : 1);
          }
        } finally { self.env.writeValidation = previous; }
      });
    }

    it('stores valid socket batch items, reports refusals in order and checks edits/unsets', async function () {
      const previous = self.env.writeValidation;
      self.env.writeValidation = 'reject';
      try {
        const n = nextN(), id = idFor('treatments', 'oid', n);
        const doc = Object.assign(body('treatments', n), {_id: id.asked,
          eventType: 'Temporary Target', duration: 30, targetBottom: 5, targetTop: 6});
        const bad = Object.assign({}, doc, {_id: idFor('treatments', 'oid', nextN()).asked, targetTop: 1});
        const batch = await wsEmit('dbAdd', {collection: 'treatments', data: [doc, bad]});
        should(batch.length).equal(2);
        should(String(batch[0]._id)).equal(id.asked);
        should(batch[1]._id).equal(undefined);
        should(batch[1].refused.status).equal(400);
        should(batch[1].refused.rules).containDeep([{rule: 'tt-order', field: 'targetBottom'}]);
        should(await collection('treatments').findOne({_id: new ObjectID(bad._id)})).equal(null);
        should((await storedFor('treatments', id)).length).equal(1);
        await wsEmit('dbAdd', {collection: 'treatments', data: doc});
        for (const [event, data] of [['dbUpdate', {targetBottom: 9}], ['dbUpdateUnset', {targetTop: ''}]]) {
          const reply = await wsEmit(event, {collection: 'treatments', _id: id.asked, data});
          should(reply.result).equal('Unable to process update');
          // The unlabelled 5-6 target was stored in mg/dL (BF-194); a
          // refused edit leaves it as stored.
          const stored = (await storedFor('treatments', id))[0];
          should(stored.targetBottom).equal(5 * MMOL_TO_MGDL);
          should(stored.targetTop).equal(6 * MMOL_TO_MGDL);
          should(stored.units).equal('mg/dl');
        }
        const edit = await wsEmit('dbUpdate', {collection: 'treatments', _id: id.asked, data: {notes: 'edited'}});
        should(edit.result).equal('success');
      } finally { self.env.writeValidation = previous; }
    });
  });

  for (const mode of ['off', 'log', 'reject']) {
    for (const invalid of [[true, false, true], [true, true], [false, false]]) {
      it('keeps ordered socket results for ' + mode + ' with invalid items ' + invalid.join(','), async function () {
        const previous = self.env.writeValidation;
        self.env.writeValidation = mode;
        try {
          const ids = [], docs = invalid.map((bad, i) => {
            const n = nextN(), id = idFor('treatments', 'oid', n);
            ids.push(id);
            return Object.assign(body('treatments', n, 'slot-' + i), {_id: id.asked,
              eventType: 'Temporary Target', duration: 30, targetBottom: 5, targetTop: bad ? 1 : 6});
          });
          const before = commits.length;
          const reply = await wsEmit('dbAdd', {collection: 'treatments', data: docs});
          should(reply.length).equal(docs.length);
          for (let i = 0; i < docs.length; i++) {
            should(reply[i].crud).equal('slot-' + i);
            const refused = mode === 'reject' && invalid[i];
            should((await storedFor('treatments', ids[i])).length).equal(refused ? 0 : 1);
            if (refused) {
              should(reply[i]._id).equal(undefined);
              should(reply[i].refused.status).equal(400);
              should(reply[i].refused.message).match(/targetBottom must not be above targetTop/);
              should(reply[i].refused.rules).containDeep([{rule: 'tt-order', field: 'targetBottom'}]);
            } else {
              should(String(reply[i]._id)).equal(ids[i].asked);
              should(reply[i].refused).equal(undefined);
            }
          }
          should(commits.length - before).equal(invalid.filter(bad => mode !== 'reject' || !bad).length);
        } finally { self.env.writeValidation = previous; }
      });
    }
  }

  for (const mode of ['off', 'log', 'reject']) {
    for (const pattern of [['fail', 'bad', 'good'], ['bad', 'fail', 'good'],
      ['bad', 'good', 'fail'], ['fail', 'bad', 'fail']]) {
      it('keeps socket batch outcomes for ' + mode + ' with ' + pattern.join(','), async function () {
        const previous = self.env.writeValidation;
        self.env.writeValidation = mode;
        const raw = collection('treatments'), prototype = Object.getPrototypeOf(raw), original = prototype.insertOne;
        try {
          const ids = [], docs = pattern.map((kind, i) => {
            const n = nextN(), id = idFor('treatments', 'oid', n);
            ids.push(id);
            return Object.assign(body('treatments', n, kind + '-' + i), {_id: id.asked,
              eventType: 'Temporary Target', duration: 30, targetBottom: kind === 'bad' ? 9 : 5, targetTop: 6},
              kind === 'fail' ? {refused: {spoofed: true}} : kind === 'bad' ? {failed: {spoofed: true}} : {});
          });
          prototype.insertOne = async function (doc, ...args) {
            if (typeof doc.crud === 'string' && doc.crud.startsWith('fail-')) throw new Error('synthetic private driver detail');
            return original.call(this, doc, ...args);
          };
          const before = commits.length;
          const reply = await wsEmit('dbAdd', {collection:'treatments', data:docs});
          const returned = pattern.map((kind, i) => i).filter(i => mode === 'reject' || pattern[i] !== 'fail');
          should(reply.length).equal(returned.length);
          for (let slot = 0; slot < returned.length; slot++) {
            const i = returned[slot], kind = pattern[i];
            should(reply[slot].crud).equal(kind + '-' + i);
            if (mode === 'reject' && kind === 'fail') {
              should(reply[slot]._id).equal(undefined);
              should(reply[slot].refused).equal(undefined);
              should(reply[slot].failed).deepEqual({status: 500, message: 'Treatment write could not be confirmed'});
              should(reply[slot].srvCreated).equal(undefined);
              should(reply[slot].srvModified).equal(undefined);
            } else if (mode === 'reject' && kind === 'bad') {
              should(reply[slot]._id).equal(undefined);
              should(reply[slot].refused.status).equal(400);
              should(reply[slot].failed).equal(undefined);
            } else {
              should(String(reply[slot]._id)).equal(ids[i].asked);
              if (kind === 'bad') should(reply[slot].failed).deepEqual({spoofed: true});
              else should(reply[slot].failed).equal(undefined);
            }
          }
          should(JSON.stringify(reply).includes('synthetic private driver detail')).equal(false);
          for (let i = 0; i < pattern.length; i++) {
            const stored = pattern[i] !== 'fail' && (mode !== 'reject' || pattern[i] !== 'bad');
            should((await storedFor('treatments', ids[i])).length).equal(stored ? 1 : 0);
          }
          should(commits.length - before).equal(pattern.filter(kind => kind !== 'fail' && (mode !== 'reject' || kind !== 'bad')).length);
        } finally { prototype.insertOne = original; self.env.writeValidation = previous; }
      });
    }
  }

  for (const mode of ['off', 'log', 'reject']) {
    it('handles an unexpected socket batch exception in ' + mode + ' mode', async function () {
      const previous = self.env.writeValidation;
      self.env.writeValidation = mode;
      const raw = collection('treatments'), prototype = Object.getPrototypeOf(raw), original = prototype.insertOne;
      try {
        const docs = ['fail', 'bad', 'good'].map((kind, i) => {
          const n = nextN(), id = idFor('treatments', 'oid', n);
          return Object.assign(body('treatments', n, kind + '-' + i), {_id: id.asked,
            eventType: 'Temporary Target', duration: 30, targetBottom: kind === 'bad' ? 9 : 5, targetTop: 6});
        });
        prototype.insertOne = async function (doc, ...args) {
          if (doc.crud === 'fail-0') throw {};
          return original.call(this, doc, ...args);
        };
        const reply = await wsEmit('dbAdd', {collection: 'treatments', data: docs});
        if (mode !== 'reject') {
          should(reply).deepEqual([]);
          should(await raw.findOne({_id: new ObjectID(docs[1]._id)})).equal(null);
          should(await raw.findOne({_id: new ObjectID(docs[2]._id)})).equal(null);
        } else {
          should(reply.length).equal(3);
          should(reply[0].failed.status).equal(500);
          should(reply[1].refused.status).equal(400);
          should(reply[2]._id).not.equal(undefined);
          should(reply.map(item => item.crud)).deepEqual(['fail-0', 'bad-1', 'good-2']);
        }
      } finally { prototype.insertOne = original; self.env.writeValidation = previous; }
    });
  }

  it('keeps non-treatment socket batch failure replies unchanged in reject mode', async function () {
    const previous = self.env.writeValidation;
    self.env.writeValidation = 'reject';
    const raw = collection('food'), prototype = Object.getPrototypeOf(raw), original = prototype.insertOne;
    try {
      const ids = [], docs = ['fail', 'good', 'good'].map((kind, i) => {
        const n = nextN(), id = idFor('food', 'oid', n);
        ids.push(id);
        return Object.assign(body('food', n, kind + '-food-' + i), {_id: id.asked});
      });
      prototype.insertOne = async function (doc, ...args) {
        if (doc.crud === 'fail-food-0') throw new Error('synthetic food failure');
        return original.call(this, doc, ...args);
      };
      const reply = await wsEmit('dbAdd', {collection:'food', data:docs});
      should(reply.length).equal(2);
      should(reply.map(item => item.crud)).deepEqual(['good-food-1', 'good-food-2']);
      should((await storedFor('food', ids[0])).length).equal(0);
      should((await storedFor('food', ids[1])).length).equal(1);
      should((await storedFor('food', ids[2])).length).equal(1);
    } finally { prototype.insertOne = original; self.env.writeValidation = previous; }
  });

  it('marks a lost write acknowledgement as unconfirmed and finds the record on replay', async function () {
    const previous = self.env.writeValidation;
    self.env.writeValidation = 'reject';
    const raw = collection('treatments'), prototype = Object.getPrototypeOf(raw), original = prototype.insertOne;
    try {
      const n = nextN(), id = idFor('treatments', 'oid', n);
      const doc = Object.assign(body('treatments', n, 'ack-lost'), {_id: id.asked,
        eventType: 'Temporary Target', duration: 30, targetBottom: 5, targetTop: 6});
      let once = false;
      prototype.insertOne = async function (input, ...args) {
        const result = await original.call(this, input, ...args);
        if (input.crud === 'ack-lost' && !once) { once = true; throw new Error('synthetic acknowledgement loss'); }
        return result;
      };
      const first = await wsEmit('dbAdd', {collection:'treatments', data:[doc]});
      should(first.length).equal(1);
      should(first[0]._id).equal(undefined);
      should(first[0].failed.message).equal('Treatment write could not be confirmed');
      should((await storedFor('treatments', id)).length).equal(1);
      const replay = await wsEmit('dbAdd', {collection:'treatments', data:[doc]});
      should(String(replay[0]._id)).equal(id.asked);
      should((await storedFor('treatments', id)).length).equal(1);
    } finally { prototype.insertOne = original; self.env.writeValidation = previous; }
  });

  for (const mode of ['off', 'log', 'reject']) {
    for (const batch of [false, true]) {
      it('keeps late socket refusals in place for ' + mode + ' ' + (batch ? 'batches' : 'single uploads'), async function () {
        const previous = self.env.writeValidation;
        self.env.writeValidation = mode;
        try {
          const n = nextN(), oldId = idFor('treatments', 'oid', n);
          const old = Object.assign(body('treatments', n), {_id: oldId.stored,
            eventType: 'Temporary Target', duration: 30, targetBottom: 9, targetTop: 6});
          await collection('treatments').insertOne(old);
          const incomingId = idFor('treatments', 'oid', nextN());
          // Valid input passes preflight; the +/-2-second match then tries to
          // change the timestamp of a legacy target that fails validation.
          const incoming = Object.assign({}, old, {_id: incomingId.asked, targetBottom: 5,
            created_at: new Date(when(n) + 1000).toISOString(), notes: 'late-refusal-slot',
            failed: {spoofed: true}});
          const items = [incoming], ids = [];
          if (batch) {
            for (const valid of [false, true]) {
              const next = nextN(), id = idFor('treatments', 'oid', next);
              ids.push(id);
              items.push(Object.assign(body('treatments', next), {_id: id.asked,
                eventType: 'Temporary Target', duration: 30, targetBottom: valid ? 5 : 9, targetTop: 6,
                notes: valid ? 'accepted-slot' : 'preflight-refusal-slot'}));
            }
          }
          const before = commits.length;
          const reply = await wsEmit('dbAdd', {collection: 'treatments', data: batch ? items : incoming});
          should(reply.length).equal(items.length);
          const current = (await storedFor('treatments', oldId))[0];
          should(current.targetBottom).equal(9);
          if (mode === 'reject') {
            should(reply[0].notes).equal('late-refusal-slot');
            should(reply[0]._id).equal(undefined);
            should(reply[0].refused.status).equal(400);
            should(reply[0].failed).equal(undefined);
            should(reply[0].refused.rules).containDeep([{rule: 'tt-order', field: 'targetBottom'}]);
            should(current.created_at).equal(old.created_at);
            should(current.srvModified).equal(undefined);
          } else {
            should(String(reply[0]._id)).equal(oldId.asked);
            should(reply[0].refused).equal(undefined);
            should(current.created_at).equal(incoming.created_at);
          }
          should((await storedFor('treatments', incomingId)).length).equal(0);
          if (batch) {
            should(reply[1].notes).equal('preflight-refusal-slot');
            should(reply[2].notes).equal('accepted-slot');
            should(String(reply[2]._id)).equal(ids[1].asked);
            should((await storedFor('treatments', ids[0])).length).equal(mode === 'reject' ? 0 : 1);
            should((await storedFor('treatments', ids[1])).length).equal(1);
            if (mode === 'reject') {
              should(reply[1]._id).equal(undefined);
              should(reply[1].refused.status).equal(400);
            }
          }
          should(commits.length - before).equal(mode === 'reject' ? (batch ? 1 : 0) : items.length);
        } finally { self.env.writeValidation = previous; }
      });
    }
  }

  it('does not turn a socket persistence failure into a domain refusal', async function () {
    const previous = self.env.writeValidation;
    self.env.writeValidation = 'reject';
    const raw = collection('treatments'), n = nextN(), id = idFor('treatments', 'oid', n);
    const prototype = Object.getPrototypeOf(raw), original = prototype.updateOne;
    try {
      const old = Object.assign(body('treatments', n), {_id: id.stored,
        eventType: 'Temporary Target', duration: 30, targetBottom: 5, targetTop: 6});
      await raw.insertOne(old);
      prototype.updateOne = async function (filter, ...args) {
        if (JSON.stringify(filter).includes(id.asked)) throw new Error('synthetic storage failure');
        return original.call(this, filter, ...args);
      };
      const reply = await wsEmit('dbAdd', {collection: 'treatments', data: Object.assign({}, old,
        {_id: id.asked, created_at: new Date(when(n) + 1000).toISOString()})});
      should(reply).deepEqual([]);
      should((await raw.findOne({_id: id.stored})).created_at).equal(old.created_at);
    } finally {
      prototype.updateOne = original;
      self.env.writeValidation = previous;
    }
  });

  it('gates read/search/history diagnostic headers in every representation without changing response data', async function () {
    const previous = self.env.apiV3DataWarnings;
    should(previous).equal(false);
    const identifier = 'header-opt-in';
    await collection('treatments').insertOne({identifier, app: 'crud-matrix', eventType: 'Note',
      duration: {toString: 'broken'}, created_at: new Date().toISOString(), srvModified: Date.now()});
    try {
      for (const url of ['/api/v3/treatments/' + identifier + '?fields=duration',
        '/api/v3/treatments?identifier$eq=' + identifier + '&fields=duration',
        '/api/v3/treatments/history/1577836800000?limit=1000&fields=duration']) {
        for (const format of ['application/json', 'text/csv', 'application/xml']) {
          self.env.apiV3DataWarnings = false;
          const quiet = await self.instance.get(url, self.jwt.all).set('Accept', format).expect(200);
          should(quiet.headers['nightscout-data-warnings']).equal(undefined);
          self.env.apiV3DataWarnings = true;
          const diagnosed = await self.instance.get(url, self.jwt.all).set('Accept', format).expect(200);
          should(diagnosed.headers['nightscout-data-warnings']).match(/number-shape/);
          should(diagnosed.text).equal(quiet.text);
          should(diagnosed.headers.etag).equal(quiet.headers.etag);
        }
      }
    } finally { self.env.apiV3DataWarnings = previous; }
  });

  it('returns malformed stored records without default diagnostics or invalid date headers', async function () {
    const identifier = 'architecture-malformed-time';
    await collection('treatments').insertOne({identifier, app: 'crud-matrix',
      eventType: 'Note', srvModified: {toString: 'broken'}, created_at: 'not-a-date'});
    const res = await self.instance.get('/api/v3/treatments/' + identifier, self.jwt.all).expect(200);
    should(res.body.result.srvModified).deepEqual({toString: 'broken'});
    should(res.headers['nightscout-data-warnings']).equal(undefined);
    should(res.headers['last-modified']).equal(undefined);
  });

  it('keeps /storage delivery v3-only while observing writes from every path', async function () {
    const events = [];
    const listener = event => events.push(event);
    const bus = self.instance.ctx.bus;
    bus.on('storage-socket-create', listener);
    bus.on('storage-socket-update', listener);
    try {
      const first = nextN();
      await v1('post', v1Base('treatments')).send(body('treatments', first));
      await new Promise((resolve, reject) => self.instance.ctx.treatments.create([body('treatments', nextN())],
        err => err ? reject(err) : resolve()));
      await wsEmit('dbAdd', {collection: 'treatments', data: body('treatments', nextN())});
      should(events.length).equal(0);
      const doc = body('treatments', nextN());
      doc.identifier = 'architecture-socket-control';
      await self.instance.post('/api/v3/treatments', self.jwt.all).send(doc).expect(201);
      should(events.length).equal(1);
      should(events[0].colName).equal('treatments');
    } finally {
      bus.removeListener('storage-socket-create', listener);
      bus.removeListener('storage-socket-update', listener);
    }
  });

  it('keeps cursor metadata for projected history and avoids false cancellation warnings', async function () {
    const previous = self.env.apiV3DataWarnings;
    self.env.apiV3DataWarnings = true;
    try {
      const id = 'projected-cancel';
      await collection('treatments').insertOne({identifier: id, app: 'crud-matrix', eventType: 'Temporary Target',
        duration: 0, targetBottom: 0, targetTop: 0, srvModified: Date.now()});
      const res = await self.instance.get('/api/v3/treatments/' + id + '?fields=eventType,targetBottom,targetTop', self.jwt.all).expect(200);
      should(res.headers['nightscout-data-warnings']).equal(undefined);
      should(res.body.result.duration).equal(undefined);
      const hist = await self.instance.get('/api/v3/treatments/history/1577836800000?fields=eventType&limit=1000', self.jwt.all).expect(200);
      should(hist.headers.etag).match(/^W\/"[0-9]+"$/);
      should(Number.isFinite(Date.parse(hist.headers['last-modified']))).equal(true);
      hist.body.result.forEach(doc => should(doc.srvModified).equal(undefined));
    } finally { self.env.apiV3DataWarnings = previous; }
  });

  it('refuses conflicting cancellation/end-time inputs through all four writers', async function () {
    const previous = self.env.writeValidation;
    self.env.writeValidation = 'reject';
    try {
      for (const source of ['v1', 'v3', 'socket', 'internal']) {
        const n = nextN(), id = idFor('treatments', 'oid', n);
        const doc = Object.assign(body('treatments', n), {_id: id.asked,
          eventType: 'Temporary Target', duration: 0, targetBottom: 0, targetTop: 0,
          mills: when(n), endmills: when(n) + 1800000});
        if (source === 'v1') await v1('post', v1Base('treatments')).send(doc).expect(400);
        else if (source === 'v3') {
          delete doc._id; doc.identifier = id.asked;
          await self.instance.post('/api/v3/treatments', self.jwt.all).send(doc).expect(400);
        } else if (source === 'socket') {
          const reply = await wsEmit('dbAdd', {collection: 'treatments', data: doc});
          should(reply.length).equal(1);
          should(reply[0]._id).equal(undefined);
          should(reply[0].refused.status).equal(400);
        } else {
          const err = await new Promise(resolve => self.instance.ctx.treatments.create([doc], err => resolve(err)));
          should(err.name).equal('WriteValidationError');
        }
        should((await storedFor('treatments', id)).length).equal(0);
      }
    } finally { self.env.writeValidation = previous; }
  });

  for (const sources of [['socket', 'socket'], ['v3', 'v3'], ['socket', 'v3']]) {
    it('conditionally validates concurrent ' + sources.join('/') + ' patches in Mongo', async function () {
      const step = require('../lib/storage/write-step');
      const id = idFor('treatments', 'oid', nextN());
      const raw = collection('treatments');
      await raw.insertOne({_id: id.stored, app: 'crud-matrix', eventType: 'Temporary Target',
        duration: 30, targetBottom: 100, targetTop: 140});
      let calls = 0, release;
      const barrier = new Promise(resolve => { release = resolve; });
      const observed = new Proxy(raw, {get(target, key) {
        if (key === 'updateOne') return async (...args) => {
          if (++calls <= 2) { if (calls === 2) release(); await barrier; }
          return target.updateOne(...args);
        };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      }});
      const writers = sources.map(source => step.collection(observed,
        {name: 'treatments', source, env: {writeValidation: 'reject'}}));
      const outcomes = await Promise.allSettled([
        writers[0].updateOne({_id: id.stored}, {$set: {targetBottom: 120}}),
        writers[1].updateOne({_id: id.stored}, {$set: {targetTop: 110}})
      ]);
      should(outcomes.filter(o => o.status === 'fulfilled').length).equal(1);
      should(outcomes.find(o => o.status === 'rejected').reason.name).equal('WriteValidationError');
      const stored = await raw.findOne({_id: id.stored});
      should(stored.targetBottom <= stored.targetTop).equal(true);
    });
  }

  it('stores a socket cancellation consistently and refuses unsets that reactivate invalid targets', async function () {
    const previous = self.env.writeValidation;
    self.env.writeValidation = 'reject';
    try {
      const n = nextN(), id = idFor('treatments', 'oid', n), start = when(n);
      await collection('treatments').insertOne({_id: id.stored, app: 'crud-matrix',
        eventType: 'Temporary Target', mills: start, duration: 30, durationInMilliseconds: 1800000,
        endmills: start + 1800000, targetBottom: 100, targetTop: 140});
      const reply = await wsEmit('dbUpdate', {collection: 'treatments', _id: id.asked,
        data: {duration: 0, targetBottom: 0, targetTop: 0}});
      should(reply.result).equal('success');
      const stored = (await storedFor('treatments', id))[0];
      should(stored.duration).equal(0);
      should(stored.durationInMilliseconds).equal(0);
      should(stored.endmills).equal(start);
      const unset = await wsEmit('dbUpdateUnset', {collection: 'treatments', _id: id.asked,
        data: {duration: '', durationInMilliseconds: '', endmills: ''}});
      should(unset.result).equal('Unable to process update');
      should((await storedFor('treatments', id))[0].duration).equal(0);
    } finally { self.env.writeValidation = previous; }
  });

  for (const expected of [400, 409]) {
    it('returns HTTP ' + expected + ' for a target changed after v3 route validation', async function () {
      const previous = self.env.writeValidation;
      self.env.writeValidation = 'reject';
      const raw = collection('treatments'), id = idFor('treatments', 'oid', nextN());
      const prototype = Object.getPrototypeOf(raw), original = prototype.updateOne;
      let attempts = 0;
      try {
        await raw.insertOne({_id: id.stored, identifier: id.asked, app: 'crud-matrix',
          eventType: 'Temporary Target', duration: 30, targetBottom: 100, targetTop: 140});
        prototype.updateOne = async function (filter, ...args) {
          if (filter.$and && JSON.stringify(filter).includes(id.asked)) {
            attempts++;
            // Force the race after the conditional boundary's snapshot read.
            await original.call(raw, {_id: id.stored}, {$set: expected === 400
              ? {targetTop: 110} : {duration: attempts % 2 ? 31 : 30}});
          }
          return original.call(this, filter, ...args);
        };
        await self.instance.patch('/api/v3/treatments/' + id.asked, self.jwt.all)
          .send({targetBottom: 120}).expect(expected);
        should(attempts).equal(expected === 400 ? 1 : 4);
        const stored = await raw.findOne({_id: id.stored});
        should(stored.targetBottom).equal(100);
      } finally {
        prototype.updateOne = original;
        self.env.writeValidation = previous;
      }
    });
  }

  for (const col of ['entries', 'treatments']) {
    for (const from of ['v1', 'v3', 'socket', 'internal']) {
      for (const to of ['v1', 'v3', 'socket', 'internal']) {
        it(col + ' cross-path resend ' + from + ' -> ' + to, async function () {
          const n = nextN(), id = idFor(col, 'oid', n);
          async function send(path, marker) {
            const doc = Object.assign(body(col, n, marker), {_id: id.asked, identifier: id.asked});
            if (path === 'v1') return v1('post', v1Base(col)).send(doc)
              .expect(200);
            if (path === 'v3') {
              delete doc._id;
              const res = await self.instance.post('/api/v3/' + col, self.jwt.all).send(doc);
              should([200, 201].includes(res.status)).equal(true);
              return res;
            }
            if (path === 'socket') return wsEmit('dbAdd', {collection: col, data: doc});
            return new Promise((resolve, reject) => self.instance.ctx[col].create([doc],
              (err, result) => err ? reject(err) : resolve(result)));
          }
          await send(from, 'original');
          await send(to, 'edited');
          const stored = await storedFor(col, id);
          // CHANGED EXPECTATION (ID-FIRST-MATCH slice 6, 2026-10-31): the socket's
          // dbAdd now matches on identifier first, as this comment asked for. An
          // entries re-send through the socket lands on the stored entry and
          // merges (written: edited), from every path; the v3->socket duplicate
          // is gone. Was: a socket re-send was not written, and v3->socket stored
          // a second entry. Treatments through the socket are kept unwritten here
          // until decision B (the next commit of this PR).
          const kept = col === 'treatments' && to === 'socket';
          should(stored.length).equal(1);
          should(allEdited(stored)).equal(!kept);
        });
      }
    }
  }

});
