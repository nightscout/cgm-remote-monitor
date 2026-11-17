'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const should = require('should');
const Ajv2020 = require('ajv/dist/2020');
const language = require('../lib/language')();

const registration = require('../lib/registration');

const BASE = registration.BASE;
const SYNC = BASE + '/sync';
const CATALOGUE = BASE + '/controllers';
const CATALOGUE_DIR = path.join(__dirname, '../lib/registration/catalogue');
const SCHEMA_DIR = path.join(__dirname, '../lib/registration/schemas');

// Members of the capability document not offered yet (registration
// specification section 4): absent means no command path.
const NOT_OFFERED = ['commands'];

// The grammar members every hub interprets (registration section 4).
const REQUIRED_INTERPRETS = [
  'apiVersion', 'kind', 'metadata.vendor', 'metadata.product', 'metadata.tier',
  'spec.cadence', 'spec.documents.*.collection', 'spec.documents.*.decomposesTo'
];

function vendored (name) {
  return JSON.parse(fs.readFileSync(path.join(CATALOGUE_DIR, name), 'utf8'));
}

function capabilityValidator () {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'hub-capabilities.schema.json'), 'utf8'));
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

function pathsOf (body) {
  const paths = [SYNC, body.wellKnown.catalogue];
  body.wellKnown.kinds.forEach(kind => paths.push(kind.href));
  return paths;
}

describe('controller registration well-known documents', function () {
  const self = this;
  this.timeout(15000);

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    delete process.env.CONTROLLER_REGISTRATION;
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'denied';
    // Other suites change INSECURE_USE_HTTP in process.env (tests/env.test.js
    // unsets it); answer over plain http here rather than redirecting to https.
    env.insecureUseHttp = true;
    self.env = env;
    // Booted with the flag on, so the registration store is set up.
    env.controllerRegistration = true;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      const createApp = require('../lib/server/app');
      env.controllerRegistration = false;
      self.off = createApp(env, ctx);
      env.controllerRegistration = true;
      self.on = createApp(env, ctx);
      env.controllerRegistration = false;
      done();
    });
  });

  after(function () {
    delete process.env.CONTROLLER_REGISTRATION;
    require('../lib/server/env')();
  });

  describe('CONTROLLER_REGISTRATION', function () {
    afterEach(function () {
      delete process.env.CONTROLLER_REGISTRATION;
    });

    it('is off when unset', function () {
      delete process.env.CONTROLLER_REGISTRATION;
      require('../lib/server/env')().controllerRegistration.should.equal(false);
    });

    it('is on for true or on, and off for anything else', function () {
      [['true', true], ['on', true], ['TRUE', true], ['false', false], ['off', false], ['yes', false], ['1', false]]
        .forEach(function (pair) {
          process.env.CONTROLLER_REGISTRATION = pair[0];
          require('../lib/server/env')().controllerRegistration.should.equal(pair[1], pair[0]);
        });
    });
  });

  describe('flag off', function () {
    it('answers 404 on every path, as a path nothing serves', async function () {
      const none = await request(self.off).get(BASE + '/not-served').expect(404);
      const paths = [SYNC, CATALOGUE].concat(registration.KINDS.map(id => CATALOGUE + '/' + id));
      for (const p of paths) {
        const res = await request(self.off).get(p).expect(404);
        res.headers['content-type'].should.equal(none.headers['content-type']);
        res.text.should.equal(none.text.replace(BASE + '/not-served', p));
      }
    });

    it('serves no registration or instance resource', async function () {
      const id = '00000000-0000-4000-8000-00000000000a';
      for (const p of [registration.SUBMIT_HREF + '/Example/Controller', registration.INSTANCES_HREF,
        registration.INSTANCES_HREF + '/' + id]) {
        await request(self.off).get(p).expect(404);
        await request(self.off).put(p).send({}).expect(404);
      }
    });
  });

  describe('flag on', function () {
    it('validates against the vendored capability schema', async function () {
      const res = await request(self.on).get(SYNC).expect(200).expect('Content-Type', /application\/json/);
      const validate = capabilityValidator();
      const ok = validate(res.body);
      should(validate.errors).equal(null);
      ok.should.equal(true);
    });

    it('offers submissions and instances, no commands, and interprets the required members', async function () {
      const res = await request(self.on).get(SYNC).expect(200);
      NOT_OFFERED.forEach(member => res.body.should.not.have.property(member));
      res.body.submit.should.eql({ href: '/api/v4/registrations', tiers: ['controller-owned'],
        permissions: { submit: 'api:registrations:create', retire: 'api:registrations:delete' } });
      res.body.instances.should.eql({ leaseSeconds: 900, instanceId: 'uuid-v4', roles: ['source', 'command-sink'],
        channels: ['slot', 'element'], labels: { maxLabels: 8, maxKeyLength: 96, maxValueLength: 64 } });
      // An entry covers the member and everything beneath it.
      REQUIRED_INTERPRETS.filter(member => !res.body.grammar.interprets.some(entry =>
        member === entry || member.indexOf(entry + '.') === 0)).should.eql([]);
      res.body.wellKnown.catalogue.should.equal(CATALOGUE);
    });

    it('resolves every href it names', async function () {
      const res = await request(self.on).get(SYNC).expect(200);
      const paths = pathsOf(res.body);
      paths.length.should.equal(2 + registration.KINDS.length);
      for (const p of paths) {
        const doc = await request(self.on).get(p).expect(200).expect('Content-Type', /application\/json/);
        doc.body.should.have.property('apiVersion', 'nightscout.dev/sync/v1');
      }
    });

    it('serves the vendored catalogue and nothing else', async function () {
      const files = fs.readdirSync(CATALOGUE_DIR).sort();
      files.should.eql(registration.KINDS.map(id => id + '.json')
        .concat(['mappings.json', 'shared-slots.json']).sort());

      const caps = (await request(self.on).get(SYNC).expect(200)).body;
      const index = (await request(self.on).get(CATALOGUE).expect(200)).body;
      const expected = registration.KINDS.map(function (id) {
        const meta = vendored(id + '.json').document.metadata;
        return { id: id, vendor: meta.vendor, product: meta.product, href: CATALOGUE + '/' + id };
      });
      caps.wellKnown.kinds.should.eql(expected);
      index.kinds.should.eql(expected);

      const slots = vendored('shared-slots.json').slots.map(s => ({ name: s.name }));
      caps.wellKnown.slots.should.eql(slots);
      index.slots.should.eql(slots);
      caps.wellKnown.mappings.should.eql(vendored('mappings.json').mappings);
      index.mappings.should.eql(vendored('mappings.json').mappings);

      for (const id of registration.KINDS) {
        const doc = await request(self.on).get(CATALOGUE + '/' + id).expect(200);
        doc.body.should.eql(vendored(id + '.json').document);
      }
      await request(self.on).get(CATALOGUE + '/not-a-kind').expect(404);
    });

    it('needs no credential with anonymous reads denied, and sets no cookie', async function () {
      self.env.settings.authDefaultRoles.should.equal('denied');
      await request(self.on).get('/api/v1/entries.json').expect(401);
      const caps = (await request(self.on).get(SYNC).expect(200)).body;
      for (const p of pathsOf(caps)) {
        const res = await request(self.on).get(p).expect(200);
        should(res.headers['set-cookie']).equal(undefined, p);
        res.headers['cache-control'].should.equal('public, max-age=3600');
        should.exist(res.headers.etag);
      }
    });

    it('keeps no-store for a request that carries a credential', async function () {
      const res = await request(self.on).get(SYNC + '?token=fixture-token').expect(200);
      res.headers['cache-control'].should.equal('no-store');
    });

    it('answers other methods as a path nothing serves', async function () {
      const none = await request(self.on).post(BASE + '/not-served').expect(404);
      for (const p of [SYNC, CATALOGUE]) {
        const res = await request(self.on).post(p).send({}).expect(404);
        res.text.should.equal(none.text.replace(BASE + '/not-served', p));
      }
    });
  });
});
