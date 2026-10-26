'use strict';

// API v3 does not write a record to the server log because the client sent
// its own identifier (BF-186).
//
// resolveIdentifier compared a client's identifier with the one the server
// would compute and, when they differed, logged a warning and then the whole
// document, health values included, on every create, PUT and deduplication.
// A client-sent identifier is the documented way to name a record, so neither
// is logged now.

require('should');

describe('API3: a client identifier is not logged with its record (BF-186)', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , opTools = require('../lib/api3/shared/operationTools')
    ;

  self.timeout(15000);

  const MARKER = 'bf186-log-marker';

  // Everything console.log, warn, info and error print while fn runs.
  async function captured (fn) {
    const lines = [];
    const saved = {};
    ['log', 'warn', 'info', 'error'].forEach(function (name) {
      saved[name] = console[name];
      console[name] = function () {
        lines.push(Array.prototype.map.call(arguments, function (a) {
          return typeof a === 'string' ? a : require('util').inspect(a, { depth: 5 });
        }).join(' '));
      };
    });
    try {
      await fn();
    } finally {
      Object.keys(saved).forEach(function (name) { console[name] = saved[name]; });
    }
    return lines.join('\n');
  }

  // Synthetic values only.
  function treatment (extra) {
    return Object.assign({
      eventType: 'Carb Correction', date: Date.UTC(2021, 7, 1, 12, 0), utcOffset: 0
      , app: MARKER, device: MARKER, carbs: 37, notes: MARKER + ' notes'
    }, extra);
  }

  before(async () => {
    self.instance = await instance.create({});
    let authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    await self.instance.ctx.store.collection(self.instance.env.treatments_collection).deleteMany({ app: MARKER });
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  it('resolveIdentifier keeps a client identifier and prints nothing', async () => {
    const doc = treatment({ identifier: 'client-supplied-0001' });
    const log = await captured(async function () { opTools.resolveIdentifier(doc); });
    doc.identifier.should.equal('client-supplied-0001');
    log.should.equal('');
  });

  it('resolveIdentifier computes an identifier when none is sent (control)', () => {
    const doc = treatment({});
    opTools.resolveIdentifier(doc);
    doc.identifier.should.equal(opTools.calculateIdentifier(doc));
  });

  it('a v3 POST with a client identifier leaves the record out of the log', async () => {
    const log = await captured(async function () {
      await self.instance.post('/api/v3/treatments', self.jwt.all)
        .send(treatment({ identifier: 'client-supplied-0002' })).expect(201);
    });
    log.should.not.containEql(MARKER);
    log.should.not.containEql('client-supplied-0002');
  });

  it('a v3 PUT with a client identifier leaves the record out of the log', async () => {
    const log = await captured(async function () {
      await self.instance.put('/api/v3/treatments/client-supplied-0003', self.jwt.all)
        .send(treatment({ identifier: 'client-supplied-0003', date: Date.UTC(2021, 7, 1, 12, 5) })).expect(201);
    });
    log.should.not.containEql(MARKER);
  });
});
