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
// A cell whose EXPECT carries a third value is behaviour kept as it is,
// pending a maintainer decision: the cell asserts today's outcome, and the
// third value is the outcome the consistent rule would give.
//
// Set CRUD_MATRIX_OUT to a file path to write every cell's expected and
// observed outcome as JSON.
//
// Synthetic records only.

var should = require('should');
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
// Expected outcomes. Each returns [expected, why] for one cell, or
// [expected, why, ideal] for behaviour kept pending a maintainer decision.
// ---------------------------------------------------------------------------

function isHexForm (form) { return form !== 'uuid'; }

var V3_NON_HEX = 'v3 looks a non-hex identifier up in `identifier` only, not in the _id it lists the record under; decision';

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
        if (stored === 'string') {
          return ['200 [ObjectId,string]', 'devicestatus create has no check for the id already stored as a string (lib/server/devicestatus.js), so the re-send is stored beside it; decision'
            , '500 [string]'];
        }
        return ['500 [ObjectId]', 'a re-sent devicestatus _id is refused as a duplicate'];
      case 'profile':
        return ['500 [' + stored + ']', 'a re-sent profile _id is refused as a duplicate (BF-99 create guard)'];
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
  // documents"). For a non-hex _id its filters look in `identifier` only, and
  // tests/api3.storage.modify.test.js asserts that filter; decision.
  , 'v3 get': function (col, form) {
    if (form === 'uuid') return ['404', V3_NON_HEX, '200'];
    return ['200', 'GET by the identifier v3 lists the v1 record under finds it'];
  }
  , 'v3 put': function (col, form) {
    if (form === 'uuid') return ['201 n=2 edited=false', V3_NON_HEX, '200 n=1 edited=true'];
    if (form === 'oidU') return ['400 n=1 edited=false', 'v3 identifiers are immutable strings: a PUT naming an ObjectId record by its upper-case hex would change its identifier'];
    return ['200 n=1 edited=true', 'v3 PUT by identifier replaces the v1 record, leaving one'];
  }
  , 'v3 delete': function (col, form) {
    if (form === 'uuid') return ['404 n=1', V3_NON_HEX, '200 n=0'];
    return ['200 n=0', 'v3 permanent DELETE by identifier removes the v1 record'];
  }
  , 'v3 resend': function (col, form) {
    if (form === 'uuid') {
      // treatments, entries and devicestatus have dedup fallback fields: the
      // create finds the record by them, then replaces by identifier, misses,
      // inserts a copy and answers 500 (lib/api3/generic/update/replace.js)
      if (['treatments', 'entries', 'devicestatus'].indexOf(col) !== -1) return ['500 n=2 edited=false', V3_NON_HEX, '200 n=1 edited=true'];
      return ['201 n=2 edited=false', V3_NON_HEX, '200 n=1 edited=true'];
    }
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
    it(key + ' | ' + col + ' | ' + form + ' -> ' + exp[0] + (exp[2] ? ' (kept; consistent: ' + exp[2] + ')' : ''), async function () {
      var observed;
      try {
        observed = await run();
      } catch (err) {
        observed = 'threw: ' + (err && err.message ? err.message : String(err));
      }
      results.push({ api: api, op: op, col: col, form: form, expected: exp[0], observed: observed, why: exp[1], ideal: exp[2] || exp[0] });
      should(observed).equal(exp[0]);
    });
  }

  before(async function () {
    self.instance = await instance.create({ useHttps: false });
    self.env = self.instance.env;
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
});
