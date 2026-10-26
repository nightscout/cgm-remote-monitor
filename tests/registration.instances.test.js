'use strict';

const crypto = require('crypto');
const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

const canonical = require('../lib/registration/canonical');
const fixture = require('./fixtures/registration/example-controller.json');

const SECRET = 'this is my long pass phrase';
const SECRET_HASH = crypto.createHash('sha1').update(SECRET).digest('hex');
const BASE = '/api/v4/registrations';
const INSTANCES = '/api/v4/instances';
const A = BASE + '/Example/NegotiationController';
const B = BASE + '/Example/OtherController';
const IA = '00000000-0000-4000-8000-00000000000a';
const IB = '00000000-0000-4000-8000-00000000000b';
const START = Date.parse('2026-10-15T12:00:00Z');

function registration (product) {
  const out = JSON.parse(JSON.stringify(fixture.registration));
  out.metadata.product = product;
  return out;
}

// The body names its product (registration section 7, amendment of
// 2026-10-26): the definition's own vendor and product.
function instanceBody (definition, roles, labels) {
  const body = { apiVersion: 'nightscout.dev/sync/v1', kind: 'ControllerInstance',
    product: { vendor: definition.metadata.vendor, product: definition.metadata.product },
    definitionId: canonical.definitionId(definition), roles: roles };
  if (labels) { body.labels = labels; }
  return body;
}

const OVERRIDE_SOURCE = { channel: 'override', role: 'source', provenance: 'device' };

function resultOf (res, channel) {
  return res.body.roles.find(r => r.channel === (channel || 'override')).result;
}

describe('controller registration: definitions, instances and roles', function () {
  const self = this;
  this.timeout(30000);

  before(function (done) {
    process.env.API_SECRET = SECRET;
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'denied';
    // Other suites change INSECURE_USE_HTTP in process.env (tests/env.test.js
    // unsets it); answer over plain http here rather than redirecting to https.
    env.insecureUseHttp = true;
    env.controllerRegistration = true;
    self.env = env;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.now = START;
      self.app = require('express')();
      require('../lib/middleware/configure-request')(self.app);
      self.app.use(require('../lib/registration')(env, ctx, { clock: () => self.now }));
      done();
    });
  });

  // Subjects for the authority checks: two controllers with the
  // registration permissions, and a reader without them.
  before(async function () {
    const db = self.ctx.store.db;
    const prefix = self.env.authentication_collections_prefix;
    await db.collection(prefix + 'roles').deleteMany({ name: /^registration-instances-test/ });
    await db.collection(prefix + 'subjects').deleteMany({ name: /^registration-instances-test/ });
    await db.collection(prefix + 'roles').insertOne({ name: 'registration-instances-test-controller',
      permissions: ['api:registrations:create', 'api:registrations:delete'] });
    await db.collection(prefix + 'subjects').insertMany([
      { name: 'registration-instances-test-a', roles: ['registration-instances-test-controller'] },
      { name: 'registration-instances-test-b', roles: ['registration-instances-test-controller'] },
      { name: 'registration-instances-test-reader', roles: ['readable'] }
    ]);
    await new Promise((resolve, reject) => self.ctx.authorization.storage.reload(err => err ? reject(err) : resolve()));
    self.tokens = {};
    self.ctx.authorization.storage.subjects.forEach(s => { self.tokens[s.name.replace('registration-instances-test-', '')] = s.accessToken; });
  });

  after(async function () {
    self.env.controllerRegistration = false;
    const db = self.ctx.store.db;
    const prefix = self.env.authentication_collections_prefix;
    await db.collection(prefix + 'roles').deleteMany({ name: /^registration-instances-test/ });
    await db.collection(prefix + 'subjects').deleteMany({ name: /^registration-instances-test/ });
    await new Promise((resolve, reject) => self.ctx.authorization.storage.reload(err => err ? reject(err) : resolve()));
  });

  async function reset () {
    const db = self.ctx.store.db;
    for (const name of ['registrations_collection', 'registration_namespaces_collection', 'registration_definitions_collection',
      'registration_instances_collection', 'registration_role_holders_collection', 'registration_pins_collection']) {
      await db.collection(self.env[name]).deleteMany({});
    }
    self.now = START;
    // Two products whose `override` slot is a shared slot, so their
    // instances contend for its roles.
    await put(A, registration('NegotiationController'), { 'If-None-Match': '*' }).expect(201);
    await put(B, registration('OtherController'), { 'If-None-Match': '*' }).expect(201);
  }

  function put (href, body, headers) {
    let req = request(self.app).put(href).set('api-secret', SECRET_HASH);
    Object.keys(headers || {}).forEach(k => { req = req.set(k, headers[k]); });
    return req.send(body);
  }

  function claim (product, instanceId, roles, headers) {
    const reg = registration(product === A ? 'NegotiationController' : 'OtherController');
    return put(INSTANCES + '/' + instanceId, instanceBody(reg, roles || [OVERRIDE_SOURCE]), headers || { 'If-None-Match': '*' });
  }

  // A request with only the credential given: a token (`?token=`), or none.
  function as (method, href, body, headers, token) {
    let req = request(self.app)[method](href + (token ? '?token=' + encodeURIComponent(token) : ''));
    Object.keys(headers || {}).forEach(k => { req = req.set(k, headers[k]); });
    return body === undefined ? req : req.send(body);
  }

  function codes (res) {
    return (res.body.reasons || []).map(r => r.code);
  }

  async function storedInstance (instanceId) {
    return self.ctx.store.db.collection(self.env.registration_instances_collection).findOne({ _id: instanceId });
  }

  async function holders () {
    return self.ctx.store.db.collection(self.env.registration_role_holders_collection).find({}).toArray();
  }

  beforeEach(reset);

  it('advertises instances and grants a role to the first claimant', async function () {
    const caps = await request(self.app).get('/.well-known/nightscout/sync').expect(200);
    caps.body.instances.leaseSeconds.should.equal(900);
    const res = await claim(A, IA).expect(201);
    resultOf(res).should.equal('granted');
    res.body.instance.leaseExpiresAt.should.equal('2026-10-15T12:15:00Z');
    const other = await claim(B, IB).expect(201);
    resultOf(other).should.equal('refused');
    other.body.roles[0].reasons.map(r => r.code).should.eql(['role-held']);
  });

  it('leaves one holder when two claimants race', async function () {
    for (let round = 0; round < 5; round++) {
      await reset();
      const [a, b] = await Promise.all([claim(A, IA), claim(B, IB)]);
      [a.status, b.status].should.eql([201, 201]);
      [resultOf(a), resultOf(b)].sort().should.eql(['granted', 'refused']);
      const held = await holders();
      held.length.should.equal(1);
      held[0].instanceId.should.equal(resultOf(a) === 'granted' ? IA : IB);
    }
  });

  it('gives a lapsed role to the claimant whose renewal comes first, and to one of two when they race', async function () {
    for (let round = 0; round < 5; round++) {
      await reset();
      const first = await claim(A, IA).expect(201);
      const etagA = first.body.instance.etag;
      await claim(B, IB).expect(201);
      const etagB = (await self.ctx.store.db.collection(self.env.registration_instances_collection).findOne({ _id: IB })).etag;
      self.now = START + 16 * 60 * 1000;
      const [a, b] = await Promise.all([
        claim(A, IA, null, { 'If-Match': '"' + etagA + '"' }),
        claim(B, IB, null, { 'If-Match': '"' + etagB + '"' })
      ]);
      [a.status, b.status].should.eql([200, 200]);
      [resultOf(a), resultOf(b)].sort().should.eql(['granted', 'refused']);
      const held = await holders();
      held.length.should.equal(1);
      held[0].instanceId.should.equal(resultOf(a) === 'granted' ? IA : IB);
    }
  });

  it('voids a holder whose product the owner blocks, even when the block races the claim', async function () {
    for (let round = 0; round < 5; round++) {
      await reset();
      const stored = await self.ctx.registrations.get({ vendor: 'Example', product: 'OtherController' });
      const [b, block] = await Promise.all([
        claim(B, IB),
        request(self.app).post(B + '/block').set('api-secret', SECRET_HASH).set('If-Match', '"' + stored.etag + '"').send({})
      ]);
      block.status.should.equal(200);
      [201, 403].should.containEql(b.status);
      const a = await claim(A, IA).expect(201);
      resultOf(a).should.equal('granted');
    }
  });

  it('refuses labels over the bounds and an unknown provenance', async function () {
    const reg = registration('NegotiationController');
    const labels = {};
    for (let i = 0; i < 9; i++) { labels['com.example/label' + i] = 'x'; }
    const many = await put(INSTANCES + '/' + IA, instanceBody(reg, [OVERRIDE_SOURCE], labels), { 'If-None-Match': '*' }).expect(422);
    many.body.reasons.map(r => r.code).should.eql(['invalid-label']);
    // An unknown provenance refuses the role, never the instance (§9).
    const odd = await put(INSTANCES + '/' + IA, instanceBody(reg, [{ channel: 'override', role: 'source', provenance: 'replayed' }]),
      { 'If-None-Match': '*' }).expect(201);
    odd.body.roles[0].result.should.equal('refused');
    odd.body.roles[0].reasons.map(r => r.code).should.eql(['unknown-provenance']);
  });

  it('keeps a replaced registration as a definition an instance may still name', async function () {
    const old = registration('NegotiationController');
    const stored = await self.ctx.registrations.get({ vendor: 'Example', product: 'NegotiationController' });
    const next = registration('NegotiationController');
    next.metadata.versionRange = '1.1.0-test';
    await put(A, next, { 'If-Match': '"' + stored.etag + '"' }).expect(200);
    const defs = await self.ctx.store.db.collection(self.env.registration_definitions_collection).find({}).toArray();
    defs.map(d => d._id).should.eql([canonical.definitionId(old)]);
    const res = await put(INSTANCES + '/' + IA, instanceBody(old, [OVERRIDE_SOURCE]), { 'If-None-Match': '*' }).expect(201);
    res.body.instance.definitionId.should.equal(canonical.definitionId(old));
  });

  it('transfers a role, pins a version and lists the instances for the owner only', async function () {
    await claim(A, IA).expect(201);
    const b = await claim(B, IB).expect(201);
    const a = await self.ctx.store.db.collection(self.env.registration_instances_collection).findOne({ _id: IA });
    const moved = await request(self.app).post(A + '/transfer-role').set('api-secret', SECRET_HASH)
      .set('If-Match', '"' + a.etag + '"').send({ transferRole: { channel: 'override', role: 'source', from: IA, to: IB } }).expect(200);
    moved.body.outcome.should.equal('applied');
    (await holders())[0].instanceId.should.equal(IB);
    should.exist(b);
    const listing = await request(self.app).get(INSTANCES).set('api-secret', SECRET_HASH).expect(200);
    listing.body.instances.map(i => i.instanceId).should.eql([IA, IB]);
    const element = 'extensions/com.example.negotiation.targets';
    const pinned = await request(self.app).post(A + '/pin-version').set('api-secret', SECRET_HASH)
      .set('If-None-Match', '*').send({ element: element, version: '1' }).expect(201);
    pinned.body.pins.pins.should.eql({ [element]: '1' });
    await request(self.app).get(INSTANCES).query({ token: 'not-a-token' }).expect(403);
  });

  describe('one flat root for instances (registration section 7, amendment of 2026-10-26)', function () {
    const regA = () => registration('NegotiationController');
    const regB = () => registration('OtherController');

    it('creates, renews and releases an instance at /api/v4/instances/<id>, the product named in the body', async function () {
      const created = await put(INSTANCES + '/' + IA, instanceBody(regA(), [OVERRIDE_SOURCE]), { 'If-None-Match': '*' }).expect(201);
      created.body.instance.should.containEql({ vendor: 'Example', product: 'NegotiationController', instanceId: IA });
      (await storedInstance(IA)).identity.should.eql({ vendor: 'Example', product: 'NegotiationController' });
      const renewed = await put(INSTANCES + '/' + IA, instanceBody(regA(), [OVERRIDE_SOURCE]),
        { 'If-Match': '"' + created.body.instance.etag + '"' }).expect(200);
      renewed.body.noop.should.equal(true);
      const listing = await request(self.app).get(INSTANCES).set('api-secret', SECRET_HASH).expect(200);
      listing.body.instances.map(i => i.instanceId).should.eql([IA]);
      await request(self.app).delete(INSTANCES + '/' + IA).set('api-secret', SECRET_HASH)
        .set('If-Match', '"' + created.body.instance.etag + '"').expect(200);
      should(await storedInstance(IA)).equal(null);
      (await holders()).length.should.equal(0);
    });

    it('refuses a renewal that names another product 422 invalid-instance, and changes nothing', async function () {
      const created = await claim(A, IA).expect(201);
      const before = await storedInstance(IA);
      const res = await put(INSTANCES + '/' + IA, instanceBody(regB(), [OVERRIDE_SOURCE]),
        { 'If-Match': '"' + created.body.instance.etag + '"' }).expect(422);
      codes(res).should.eql(['invalid-instance']);
      res.body.reasons[0].path.should.equal('product');
      (await storedInstance(IA)).should.eql(before);
      (await holders()).map(h => [h.instanceId, h.identity.product]).should.eql([[IA, 'NegotiationController']]);
    });

    it('refuses a body that names no product, and a product that is not registered', async function () {
      const none = instanceBody(regA(), [OVERRIDE_SOURCE]);
      delete none.product;
      const missing = await put(INSTANCES + '/' + IA, none, { 'If-None-Match': '*' }).expect(422);
      codes(missing).should.eql(['invalid-instance']);
      missing.body.reasons[0].path.should.equal('product');
      const unknown = await put(INSTANCES + '/' + IA, instanceBody(registration('NotRegistered'), [OVERRIDE_SOURCE]),
        { 'If-None-Match': '*' }).expect(404);
      codes(unknown).should.eql(['not-found']);
      should(await storedInstance(IA)).equal(null);
    });

    it('needs the same credentials and permissions as before, and a blocked product stays refused', async function () {
      const body = instanceBody(regA(), [OVERRIDE_SOURCE]);
      // No credential, and a credential without api:registrations:create.
      codes(await as('put', INSTANCES + '/' + IA, body, { 'If-None-Match': '*' }).expect(403)).should.eql(['not-authorised']);
      codes(await as('put', INSTANCES + '/' + IA, body, { 'If-None-Match': '*' }, self.tokens.reader).expect(403))
        .should.eql(['not-authorised']);
      should(await storedInstance(IA)).equal(null);

      // The instance binds to the subject that created it; another subject,
      // and the shared secret, may neither renew nor release it.
      const created = await as('put', INSTANCES + '/' + IA, body, { 'If-None-Match': '*' }, self.tokens.a).expect(201);
      const etag = '"' + created.body.instance.etag + '"';
      codes(await as('put', INSTANCES + '/' + IA, body, { 'If-Match': etag }, self.tokens.b).expect(403))
        .should.eql(['not-registration-owner']);
      codes(await put(INSTANCES + '/' + IA, body, { 'If-Match': etag }).expect(403)).should.eql(['not-registration-owner']);
      codes(await as('delete', INSTANCES + '/' + IA, undefined, { 'If-Match': etag }, self.tokens.b).expect(403))
        .should.eql(['not-registration-owner']);
      codes(await as('delete', INSTANCES + '/' + IA, undefined, { 'If-Match': etag }, self.tokens.reader).expect(403))
        .should.eql(['not-authorised']);
      codes(await as('delete', INSTANCES + '/' + IA, undefined, { 'If-Match': etag }).expect(403)).should.eql(['not-authorised']);
      (await storedInstance(IA)).etag.should.equal(created.body.instance.etag);

      // The owner's listing stays the owner's.
      await as('get', INSTANCES, undefined, {}, self.tokens.a).expect(403);

      // A product the owner blocked takes no instance.
      const stored = await self.ctx.registrations.get({ vendor: 'Example', product: 'OtherController' });
      await request(self.app).post(B + '/block').set('api-secret', SECRET_HASH).set('If-Match', '"' + stored.etag + '"').send({}).expect(200);
      codes(await as('put', INSTANCES + '/' + IB, instanceBody(regB(), [OVERRIDE_SOURCE]), { 'If-None-Match': '*' }, self.tokens.a)
        .expect(403)).should.eql(['blocked-by-owner']);
      should(await storedInstance(IB)).equal(null);

      await as('delete', INSTANCES + '/' + IA, undefined, { 'If-Match': etag }, self.tokens.a).expect(200);
    });

    it('no longer serves the nested instance paths', async function () {
      const none = await request(self.app).put('/api/v4/not-served').set('api-secret', SECRET_HASH).send({}).expect(404);
      const nested = A + '/instances/' + IA;
      const answers = [
        ['put', nested, await put(nested, instanceBody(regA(), [OVERRIDE_SOURCE]), { 'If-None-Match': '*' })],
        ['delete', nested, await request(self.app).delete(nested).set('api-secret', SECRET_HASH).set('If-Match', '"x"')],
        ['get', BASE + '/instances', await request(self.app).get(BASE + '/instances').set('api-secret', SECRET_HASH)]
      ];
      for (const [method, p, res] of answers) {
        res.status.should.equal(404, method + ' ' + p);
        res.text.should.equal(none.text.replace('PUT', method.toUpperCase()).replace('/api/v4/not-served', p));
      }
      should(await storedInstance(IA)).equal(null);
    });
  });
});
