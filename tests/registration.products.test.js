'use strict';

const crypto = require('crypto');
const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

const canonical = require('../lib/registration/canonical');
const fixture = require('./fixtures/registration/example-controller.json');

const SECRET = 'this is my long pass phrase';
const SECRET_HASH = crypto.createHash('sha1').update(SECRET).digest('hex');
const HREF = '/api/v4/registrations/Example/NegotiationController';
const OTHER = '/api/v4/registrations/Example/OtherController';
const NS = 'com.example.negotiation.targets';

function registration (product, changes) {
  const out = JSON.parse(JSON.stringify(fixture.registration));
  out.metadata.product = product || 'NegotiationController';
  return Object.assign(out, changes || {});
}

function codes (body) {
  return (body.reasons || []).map(r => r.code);
}

describe('controller registration: the product resource', function () {
  const self = this;
  this.timeout(15000);

  before(function (done) {
    process.env.API_SECRET = SECRET;
    delete process.env.CONTROLLER_REGISTRATION;
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'denied';
    // Other suites change INSECURE_USE_HTTP in process.env (tests/env.test.js
    // unsets it); answer over plain http here rather than redirecting to https.
    env.insecureUseHttp = true;
    env.controllerRegistration = true;
    self.env = env;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.app = require('../lib/server/app')(env, ctx);
      done();
    });
  });

  after(function () {
    self.env.controllerRegistration = false;
  });

  beforeEach(async function () {
    const db = self.ctx.store.db;
    await db.collection(self.env.registrations_collection).deleteMany({});
    await db.collection(self.env.registration_namespaces_collection).deleteMany({});
    const prefix = self.env.authentication_collections_prefix;
    await db.collection(prefix + 'roles').deleteMany({ name: /^registration-test/ });
    await db.collection(prefix + 'subjects').deleteMany({ name: /^registration-test/ });
    await db.collection(prefix + 'roles').insertOne({ name: 'registration-test-controller',
      permissions: ['api:registrations:create', 'api:registrations:delete'] });
    await db.collection(prefix + 'subjects').insertMany([
      { name: 'registration-test-a', roles: ['registration-test-controller'] },
      { name: 'registration-test-b', roles: ['registration-test-controller'] },
      { name: 'registration-test-reader', roles: ['readable'] }
    ]);
    await new Promise((resolve, reject) => self.ctx.authorization.storage.reload(err => err ? reject(err) : resolve()));
    self.tokens = {};
    self.ids = {};
    self.ctx.authorization.storage.subjects.forEach(s => {
      self.tokens[s.name] = s.accessToken;
      self.ids[s.name] = String(s._id);
    });
  });

  function put (href, body, headers, token) {
    let req = request(self.app).put(href + (token ? '?token=' + encodeURIComponent(token) : ''));
    Object.keys(headers || {}).forEach(k => { req = req.set(k, headers[k]); });
    return req.send(body);
  }

  it('creates with If-None-Match: * and answers a retried create as a no-op', async function () {
    const res = await put(HREF, fixture.registration, { 'If-None-Match': '*', 'api-secret': SECRET_HASH }).expect(201);
    res.body.outcome.should.equal('accepted');
    res.body.definitionId.should.equal(fixture.definitionId);
    res.body.registration.etag.should.equal(fixture.etagActiveApiSecret);
    res.body.registration.boundTo.should.eql({ kind: 'api-secret' });
    res.headers.etag.should.equal('"' + fixture.etagActiveApiSecret + '"');
    res.body.elements.map(e => e.result).should.eql(['accepted', 'accepted']);

    const again = await put(HREF, fixture.registration, { 'If-None-Match': '*', 'api-secret': SECRET_HASH }).expect(200);
    again.body.noop.should.equal(true);
    again.body.registration.etag.should.equal(fixture.etagActiveApiSecret);
  });

  it('answers 428 with no precondition, and stores nothing', async function () {
    const res = await put(HREF, fixture.registration, { 'api-secret': SECRET_HASH }).expect(428);
    codes(res.body).should.eql(['precondition-required']);
    should(await self.ctx.registrations.get({ vendor: 'Example', product: 'NegotiationController' })).equal(null);
  });

  it('binds to the subject, never the token, and refuses another subject', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    created.body.registration.boundTo.should.eql({ kind: 'subject', subject: self.ids['registration-test-a'] });
    created.body.registration.credentialKind.should.equal('subject');
    const etag = created.body.registration.etag;
    etag.should.equal(canonical.etag(fixture.registration, 'active', { kind: 'subject', subject: self.ids['registration-test-a'] }));

    const other = await put(HREF, registration(null, { spec: Object.assign({}, fixture.registration.spec) }),
      { 'If-Match': '"' + etag + '"' }, self.tokens['registration-test-b']).expect(403);
    codes(other.body).should.eql(['not-registration-owner']);

    const secret = await put(HREF, fixture.registration, { 'If-Match': etag, 'api-secret': SECRET_HASH }).expect(403);
    codes(secret.body).should.eql(['not-registration-owner']);
  });

  it('refuses a stale etag with the current etag and state', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*', 'api-secret': SECRET_HASH }).expect(201);
    const changed = registration();
    changed.metadata.versionRange = '1.1.0-test';
    const res = await put(HREF, changed, { 'If-Match': '"sha256:0000"', 'api-secret': SECRET_HASH }).expect(412);
    codes(res.body).should.eql(['stale-etag']);
    res.body.current.should.eql({ state: 'active', etag: created.body.registration.etag });
    const updated = await put(HREF, changed, { 'If-Match': '"' + created.body.registration.etag + '"', 'api-secret': SECRET_HASH }).expect(200);
    updated.body.registration.versionRange.should.equal('1.1.0-test');
  });

  it('lets one of two updates with the same etag through, and answers the other 412', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*', 'api-secret': SECRET_HASH }).expect(201);
    const etag = '"' + created.body.registration.etag + '"';
    const one = registration(); one.metadata.versionRange = '1.1.0-test';
    const two = registration(); two.metadata.versionRange = '1.2.0-test';
    const results = await Promise.all([
      put(HREF, one, { 'If-Match': etag, 'api-secret': SECRET_HASH }),
      put(HREF, two, { 'If-Match': etag, 'api-secret': SECRET_HASH })
    ]);
    results.map(r => r.status).sort().should.eql([200, 412]);
    const loser = results.find(r => r.status === 412);
    codes(loser.body).should.eql(['stale-etag']);
    const winner = results.find(r => r.status === 200);
    const stored = await self.ctx.registrations.get({ vendor: 'Example', product: 'NegotiationController' });
    stored.etag.should.equal(winner.body.registration.etag);
  });

  it('refuses a credential without the permission, and a request with none', async function () {
    const reader = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-reader']).expect(403);
    codes(reader.body).should.eql(['not-authorised']);
    const anonymous = await put(HREF, fixture.registration, { 'If-None-Match': '*' }).expect(403);
    codes(anonymous.body).should.eql(['not-authorised']);
  });

  it('gives a namespace to the first product that claims it', async function () {
    await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    const second = await put(OTHER, registration('OtherController'), { 'If-None-Match': '*' }, self.tokens['registration-test-b']).expect(201);
    second.body.outcome.should.equal('partial');
    const ext = second.body.elements.find(e => e.element === 'extensions/' + NS);
    ext.result.should.equal('rejected');
    codes(ext).should.eql(['namespace-claimed']);
  });

  it('leaves one holder when two products claim one namespace at once', async function () {
    const [a, b] = await Promise.all([
      put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']),
      put(OTHER, registration('OtherController'), { 'If-None-Match': '*' }, self.tokens['registration-test-b'])
    ]);
    [a.status, b.status].should.eql([201, 201]);
    const results = [a, b].map(r => r.body.elements.find(e => e.element === 'extensions/' + NS).result);
    results.sort().should.eql(['accepted', 'rejected']);
    const claims = await self.ctx.store.db.collection(self.env.registration_namespaces_collection).find({}).toArray();
    claims.length.should.equal(1);
    const winner = results[0] === 'accepted' ? 'NegotiationController' : 'OtherController';
    const accepted = [a, b].find(r => r.body.elements.find(e => e.element === 'extensions/' + NS).result === 'accepted');
    claims[0].holder.product.should.equal(accepted.body.registration.product);
    should.exist(winner);
  });

  it('retires with If-Match, keeps the namespace claimed, and reads it back', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    const retired = await request(self.app).delete(HREF + '?token=' + self.tokens['registration-test-a'])
      .set('If-Match', '"' + created.body.registration.etag + '"').expect(200);
    retired.body.outcome.should.equal('retired');
    retired.body.registration.state.should.equal('retired');
    const read = await request(self.app).get(HREF + '?token=' + self.tokens['registration-test-a']).expect(200);
    read.body.outcome.should.equal('retired');
    read.body.registration.etag.should.equal(retired.body.registration.etag);
    const other = await put(OTHER, registration('OtherController'), { 'If-None-Match': '*' }, self.tokens['registration-test-b']).expect(201);
    codes(other.body.elements.find(e => e.element === 'extensions/' + NS)).should.eql(['namespace-claimed']);
  });

  function owner (href, action, etag, body, headers) {
    let req = request(self.app).post(href + '/' + action);
    Object.keys(headers || { 'api-secret': SECRET_HASH }).forEach(k => { req = req.set(k, (headers || { 'api-secret': SECRET_HASH })[k]); });
    if (etag === '*') { req = req.set('If-None-Match', '*'); } else if (etag) { req = req.set('If-Match', '"' + etag + '"'); }
    return req.send(body || {});
  }

  it('lets only API_SECRET act as the owner', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    const etag = created.body.registration.etag;
    const res = await request(self.app).post(HREF + '/block?token=' + self.tokens['registration-test-a'])
      .set('If-Match', '"' + etag + '"').send({}).expect(403);
    codes(res.body).should.eql(['not-authorised']);
    const stale = await owner(HREF, 'block', 'sha256:0000').expect(412);
    codes(stale.body).should.eql(['stale-etag']);
    const blocked = await owner(HREF, 'block', etag).expect(200);
    blocked.body.registration.state.should.equal('blocked');
    blocked.body.registration.blockedFrom.should.equal('active');
  });

  it('blocks, then refuses the controller, then unblocks to the interrupted state', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    const blocked = await owner(HREF, 'block', created.body.registration.etag).expect(200);
    const refused = await put(HREF, fixture.registration, { 'If-Match': '"' + blocked.body.registration.etag + '"' },
      self.tokens['registration-test-a']).expect(403);
    codes(refused.body).should.eql(['blocked-by-owner']);
    const unblocked = await owner(HREF, 'unblock', blocked.body.registration.etag).expect(200);
    unblocked.body.registration.state.should.equal('active');
    unblocked.body.registration.etag.should.equal(created.body.registration.etag);
  });

  it('blocks an identity with nothing stored, and unblocking removes it', async function () {
    const blocked = await owner(HREF, 'block', '*').expect(201);
    blocked.body.registration.state.should.equal('blocked');
    const refused = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(403);
    codes(refused.body).should.eql(['blocked-by-owner']);
    await owner(HREF, 'unblock', blocked.body.registration.etag).expect(200);
    should(await self.ctx.registrations.get({ vendor: 'Example', product: 'NegotiationController' })).equal(null);
  });

  it('frees a retired product\'s namespaces for another product', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    const notRetired = await owner(HREF, 'free-namespaces', created.body.registration.etag).expect(409);
    codes(notRetired.body).should.eql(['not-retired']);
    const retired = await owner(HREF, 'retire', created.body.registration.etag).expect(200);
    const freed = await owner(HREF, 'free-namespaces', retired.body.registration.etag).expect(200);
    freed.body.registration.freedNamespaces.should.eql([NS]);
    const other = await put(OTHER, registration('OtherController'), { 'If-None-Match': '*' }, self.tokens['registration-test-b']).expect(201);
    other.body.outcome.should.equal('accepted');
  });

  it('transfers to a stored subject, refuses an unknown one, and releases for the next writer', async function () {
    const created = await put(HREF, fixture.registration, { 'If-None-Match': '*' }, self.tokens['registration-test-a']).expect(201);
    const unknown = await owner(HREF, 'transfer', created.body.registration.etag,
      { transferTo: { kind: 'subject', subject: '000000000000000000000000' } }).expect(422);
    codes(unknown.body).should.eql(['invalid-transfer']);
    const moved = await owner(HREF, 'transfer', created.body.registration.etag,
      { transferTo: { kind: 'subject', subject: self.ids['registration-test-b'] } }).expect(200);
    moved.body.registration.boundTo.should.eql({ kind: 'subject', subject: self.ids['registration-test-b'] });
    const released = await owner(HREF, 'release', moved.body.registration.etag).expect(200);
    should(released.body.registration.boundTo).equal(null);
    const bound = await put(HREF, fixture.registration, { 'If-Match': '"' + released.body.registration.etag + '"' },
      self.tokens['registration-test-a']).expect(200);
    bound.body.registration.bindingEvent.should.equal('next-writer');
    bound.body.noop.should.equal(false);
  });

  it('builds its unique identity index at boot', async function () {
    const indexes = await self.ctx.store.db.collection(self.env.registrations_collection).indexes();
    const unique = indexes.find(i => i.name === 'registration_identity_unique');
    should.exist(unique);
    unique.unique.should.equal(true);
    unique.key.should.eql({ 'identity.vendor': 1, 'identity.product': 1 });
  });

  it('fails boot when that index cannot be built', async function () {
    const name = 'registrations_index_test';
    const coll = self.ctx.store.db.collection(name);
    await coll.deleteMany({});
    await coll.insertMany([{ identity: { vendor: 'X', product: 'Y' } }, { identity: { vendor: 'X', product: 'Y' } }]);
    process.env.API_SECRET = SECRET;
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'denied';
    env.controllerRegistration = true;
    env.registrations_collection = name;
    const ctx = await new Promise(resolve => require('../lib/server/bootevent')(env, language).boot(resolve));
    await coll.drop();
    process.env.API_SECRET = SECRET;
    require('../lib/server/env')();
    ctx.bootErrors.map(e => e.desc).should.containEql('Unable to create the registration indexes');
  });
});
