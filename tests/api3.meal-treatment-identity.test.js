'use strict';

require('should');

const instance = require('./fixtures/api3/instance');
const authSubject = require('./fixtures/api3/authSubject');

describe('API3 simultaneous AAPS meal treatments', function () {
  this.timeout(30000);

  let server;
  let jwt;
  const identifiers = new Set();
  const url = '/api/v3/treatments';

  before(async function () {
    server = await instance.create({ useHttps: false });
    const auth = await authSubject(server.ctx.authorization.storage, ['all'], server.app);
    jwt = auth.jwt.all;
    if (server.role === 'single') {
      server.app.use('/api/v1', require('../lib/api')(server.env, server.ctx));
    }
  });

  afterEach(async function () {
    for (const identifier of identifiers) {
      await server.delete(`${url}/${identifier}?permanent=true`, jwt).expect(200);
    }
    identifiers.clear();
    server.cacheMonitor.clear();
  });

  after(function () {
    if (server) {
      server.ctx.bus.teardown();
      server.server.close();
    }
  });

  for (const order of [['insulin', 'carbs'], ['carbs', 'insulin']]) {
    it(`preserves same-millisecond meal records when ${order[0]} arrives first`, async function () {
      const date = Date.now();
      const common = {
        date,
        eventType: 'Meal Bolus',
        app: 'meal-identity-test',
        utcOffset: 60,
        isValid: true
      };
      // AAPS can send these without a device or a client-generated identifier.
      const documents = {
        insulin: Object.assign({}, common, { insulin: 2 }),
        carbs: Object.assign({}, common, { carbs: 30 }),
        combined: Object.assign({}, common, { insulin: 1, carbs: 10 })
      };
      const received = {};

      for (const component of [...order, 'combined']) {
        const res = await server.post(url, jwt).send(documents[component]).expect(201);
        received[component] = res.body.identifier;
        identifiers.add(res.body.identifier);
      }
      identifiers.size.should.equal(3);

      // Retrying a request must update the same record, without adding duplicates.
      for (const component of ['insulin', 'carbs', 'combined']) {
        const res = await server.post(url, jwt).send(documents[component]).expect(200);
        res.body.identifier.should.equal(received[component]);
      }

      // An edited amount must keep its identity and leave the other entry intact.
      const edited = Object.assign({}, documents.insulin, { insulin: 3 });
      const update = await server.post(url, jwt).send(edited).expect(200);
      update.body.identifier.should.equal(received.insulin);

      const bolus = await server.get(`${url}/${received.insulin}`, jwt).expect(200);
      bolus.body.result.insulin.should.equal(3);
      bolus.body.result.should.not.have.property('carbs');

      const carbs = await server.get(`${url}/${received.carbs}`, jwt).expect(200);
      carbs.body.result.carbs.should.equal(30);
      carbs.body.result.should.not.have.property('insulin');

      const combined = await server.get(`${url}/${received.combined}`, jwt).expect(200);
      combined.body.result.insulin.should.equal(1);
      combined.body.result.carbs.should.equal(10);

      const records = await server.get(url, jwt).query({ 'date$eq': date }).expect(200);
      records.body.result.length.should.equal(3);

      // xDrip reads API v1, which is available in the single-process role.
      if (server.role === 'single') {
        const legacy = await server.get('/api/v1/treatments.json', jwt)
          .query({
            'find[created_at][$gte]': new Date(date).toISOString(),
            'find[created_at][$lte]': new Date(date).toISOString()
          }).expect(200);
        legacy.body.length.should.equal(3);
        legacy.body.find(doc => doc.identifier === received.insulin).insulin.should.equal(3);
        legacy.body.find(doc => doc.identifier === received.carbs).carbs.should.equal(30);
      }
    });
  }
});
