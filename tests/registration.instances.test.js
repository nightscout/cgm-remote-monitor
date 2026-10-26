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

function instanceBody (definition, roles, labels) {
  const body = { apiVersion: 'nightscout.dev/sync/v1', kind: 'ControllerInstance',
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

  after(function () {
    self.env.controllerRegistration = false;
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
    return put(product + '/instances/' + instanceId, instanceBody(reg, roles || [OVERRIDE_SOURCE]), headers || { 'If-None-Match': '*' });
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
    const many = await put(A + '/instances/' + IA, instanceBody(reg, [OVERRIDE_SOURCE], labels), { 'If-None-Match': '*' }).expect(422);
    many.body.reasons.map(r => r.code).should.eql(['invalid-label']);
    // An unknown provenance refuses the role, never the instance (§9).
    const odd = await put(A + '/instances/' + IA, instanceBody(reg, [{ channel: 'override', role: 'source', provenance: 'replayed' }]),
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
    const res = await put(A + '/instances/' + IA, instanceBody(old, [OVERRIDE_SOURCE]), { 'If-None-Match': '*' }).expect(201);
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
    const listing = await request(self.app).get(BASE + '/instances').set('api-secret', SECRET_HASH).expect(200);
    listing.body.instances.map(i => i.instanceId).should.eql([IA, IB]);
    const element = 'extensions/com.example.negotiation.targets';
    const pinned = await request(self.app).post(A + '/pin-version').set('api-secret', SECRET_HASH)
      .set('If-None-Match', '*').send({ element: element, version: '1' }).expect(201);
    pinned.body.pins.pins.should.eql({ [element]: '1' });
    await request(self.app).get(BASE + '/instances').query({ token: 'not-a-token' }).expect(403);
  });
});
