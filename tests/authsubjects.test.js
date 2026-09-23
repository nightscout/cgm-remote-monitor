'use strict';

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

const PASSPHRASE = 'this is my long pass phrase';
// What a client actually sends: the server compares the SHA1 of the passphrase.
const API_SECRET = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

const NAME = 'authsubjects-test-subject';
const ROLE = 'authsubjects-test-role';

describe('Storing authorization subjects', function () {
  const self = this;

  this.timeout(30000);

  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = PASSPHRASE;
    process.env.HOSTNAME = 'localhost';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'denied';
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.app.use('/api/v2/authorization', ctx.authorization.endpoints);
      done();
    });
  });

  function subjectsCollection () {
    return self.ctx.store.collection(self.env.authentication_collections_prefix + 'subjects');
  }

  function rolesCollection () {
    return self.ctx.store.collection(self.env.authentication_collections_prefix + 'roles');
  }

  beforeEach(async function () {
    await subjectsCollection().deleteMany({ name: NAME });
    await rolesCollection().deleteMany({ name: ROLE });
  });

  afterEach(async function () {
    await subjectsCollection().deleteMany({ name: NAME });
    await rolesCollection().deleteMany({ name: ROLE });
  });

  async function createSubject (body) {
    await request(self.app)
      .post('/api/v2/authorization/subjects')
      .set('api-secret', API_SECRET)
      .send(body)
      .expect(200);

    return subjectsCollection().findOne({ name: NAME });
  }

  async function listSubject () {
    const listed = await request(self.app)
      .get('/api/v2/authorization/subjects')
      .set('api-secret', API_SECRET)
      .expect(200);

    return listed.body.find(subject => subject.name === NAME);
  }

  async function saveSubject (body) {
    await request(self.app)
      .put('/api/v2/authorization/subjects')
      .set('api-secret', API_SECRET)
      .send(body)
      .expect(200);

    return subjectsCollection().findOne({ name: NAME });
  }

  it('does not write the access token to the database when a subject is edited', async function () {
    await createSubject({ name: NAME, roles: ['readable'], notes: 'a note' });

    // What the stock admin UI sends: the object GET handed it, with the dialog
    // inputs written over the top. The token comes back because the UI has to
    // display it, and it must not be stored because it is derived.
    const listed = await listSubject();
    should.exist(listed.accessToken);

    const stored = await saveSubject(Object.assign({}, listed, { name: NAME, roles: ['readable'] }));

    stored.should.not.have.property('accessToken');
    stored.should.not.have.property('accessTokenDigest');
    stored.should.not.have.property('digest');
  });

  it('does not store an access token a client asks it to store', async function () {
    const created = await createSubject({
      name: NAME
      , roles: ['readable']
      , accessToken: 'chosen-by-the-client'
      , digest: 'chosen-by-the-client'
    });

    created.should.not.have.property('accessToken');
    created.should.not.have.property('digest');

    const stored = await saveSubject({
      _id: created._id.toString()
      , name: NAME
      , roles: ['readable']
      , accessToken: 'chosen-by-the-client'
    });

    stored.should.not.have.property('accessToken');
  });

  it('keeps the token derivable only with the enclave key, not readable from the collection', async function () {
    await createSubject({ name: NAME, roles: ['readable'], notes: '' });
    const listed = await listSubject();
    await saveSubject(Object.assign({}, listed, { name: NAME, roles: ['readable'] }));

    // Everything a reader of the stored documents alone could get hold of.
    const stored = await subjectsCollection().findOne({ name: NAME });
    const onDisk = JSON.stringify(stored);

    onDisk.should.not.containEql(listed.accessToken);
    onDisk.should.not.containEql(listed.accessToken.split('-').pop());
  });

  it('keeps the notes an operator saved across an edit', async function () {
    await createSubject({ name: NAME, roles: ['readable'], notes: 'insulin pump in the kitchen' });

    // The dialog fills its notes input from what GET returned, so GET has to
    // return it or the next save writes an empty string over it.
    const listed = await listSubject();
    listed.notes.should.equal('insulin pump in the kitchen');

    const stored = await saveSubject(Object.assign({}, listed, { name: NAME, roles: ['admin'] }));

    stored.notes.should.equal('insulin pump in the kitchen');
    stored.roles.should.deepEqual(['admin']);
  });

  it('does not store fields a subject document does not own', async function () {
    const created = await createSubject({
      name: NAME
      , roles: ['readable']
      , unexpected: 'from the request body'
    });

    created.should.not.have.property('unexpected');

    const stored = await saveSubject({
      _id: created._id.toString()
      , name: NAME
      , roles: ['readable']
      , unexpected: 'from the request body'
    });

    stored.should.not.have.property('unexpected');
  });

  it('does not store fields a role document does not own', function (done) {
    self.ctx.authorization.storage.createRole({
      name: ROLE
      , permissions: ['api:entries:read']
      , notes: 'a note'
      , unexpected: 'from the request body'
    }, function created (err) {
      should.not.exist(err);

      rolesCollection().findOne({ name: ROLE }).then(function (stored) {
        stored.should.not.have.property('unexpected');
        stored.permissions.should.deepEqual(['api:entries:read']);
        stored.notes.should.equal('a note');
        done();
      }).catch(done);
    });
  });
});

describe('Loading authorization subjects that already have a token on disk', function () {

  // Rows written before the access token was kept out of the collection still
  // carry it. Loading has to treat those fields as absent, because they are
  // derived values: an enclave with no key derives none, and a stale value left
  // in place would be one an attacker who could write the collection had chosen.
  function storageWith (storedSubject, apiKeySet) {
    const collections = {};

    function collection () {
      return {
        find: function find () {
          return { sort: function sort () { return { toArray: async function toArray () { return [storedSubject]; } }; } };
        }
      };
    }

    const env = {
      authentication_collections_prefix: 'auth_'
      , enclave: {
        isApiKeySet: function isApiKeySet () { return apiKeySet; }
        , getSubjectHash: function getSubjectHash () { return 'f'.repeat(64); }
      }
    };

    const ctx = {
      store: { collection: collection, ensureIndexes: function () { } }
      , collections: collections
      , language: { translate: function translate (text) { return text; } }
    };

    return require('../lib/authorization/storage')(env, ctx);
  }

  function loaded (storage) {
    return new Promise(function (resolve, reject) {
      storage.reload(function reloadedList (err) {
        return err ? reject(err) : resolve(storage.subjects[0]);
      });
    });
  }

  it('drops a stored token when there is no enclave key to derive one', async function () {
    const subject = await loaded(storageWith({
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa'
      , name: 'already-on-disk'
      , roles: ['admin']
      , accessToken: 'stale-token-from-disk'
      , accessTokenDigest: 'stale-digest-from-disk'
      , digest: 'stale-digest-from-disk'
    }, false));

    subject.should.not.have.property('accessToken');
    subject.should.not.have.property('accessTokenDigest');
    subject.should.not.have.property('digest');
  });

  it('derives over a stored token when there is an enclave key', async function () {
    const subject = await loaded(storageWith({
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa'
      , name: 'already-on-disk'
      , roles: ['admin']
      , accessToken: 'stale-token-from-disk'
      , digest: 'stale-digest-from-disk'
    }, true));

    subject.accessToken.should.equal('alreadyond-' + 'f'.repeat(16));
    subject.digest.should.equal('f'.repeat(64));
  });
});
