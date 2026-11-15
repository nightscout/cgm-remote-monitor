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

  // Rows without a usable name, which some tests below store on purpose.
  const NAMELESS = { $or: [{ name: { $not: { $type: 'string' } } }, { name: { $in: ['', '   '] } }] };

  beforeEach(async function () {
    await subjectsCollection().deleteMany({ name: NAME });
    await rolesCollection().deleteMany({ name: ROLE });
    await subjectsCollection().deleteMany(NAMELESS);
    await rolesCollection().deleteMany(NAMELESS);
  });

  afterEach(async function () {
    await subjectsCollection().deleteMany({ name: NAME });
    await rolesCollection().deleteMany({ name: ROLE });
    await subjectsCollection().deleteMany(NAMELESS);
    await rolesCollection().deleteMany(NAMELESS);
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

  // A fixed date far from now, so "kept" and "overwritten with the time of the
  // edit" cannot be confused.
  const CREATED_AT = '2020-01-02T03:04:05.000Z';

  // The request body the stock admin page sends when an operator edits a
  // subject: the object GET returned, with the dialog's inputs written over
  // it, form-encoded by jQuery. GET does not return created_at, so it is not
  // in the body.
  async function saveSubjectFromAdminPage (listed, changes) {
    const body = Object.assign({}, listed, changes);
    should.not.exist(body.created_at);
    await request(self.app)
      .put('/api/v2/authorization/subjects')
      .set('api-secret', API_SECRET)
      .type('form')
      .send(body)
      .expect(200);

    return subjectsCollection().findOne({ name: NAME });
  }

  it('keeps notes and created_at when a subject is edited on the admin page', async function () {
    await createSubject({ name: NAME, roles: ['readable'], notes: 'phone on the fridge', created_at: CREATED_AT });

    const listed = await listSubject();
    const stored = await saveSubjectFromAdminPage(listed, { roles: ['careportal', 'readable'] });

    stored.roles.should.deepEqual(['careportal', 'readable']);
    stored.notes.should.equal('phone on the fridge');
    stored.created_at.should.equal(CREATED_AT);
  });

  it('removes every role when the admin page saves a subject with none', async function () {
    // Form encoding drops an empty list, so this request has no roles field at
    // all. Taking roles from the stored document would keep access the
    // operator just removed.
    await createSubject({ name: NAME, roles: ['admin'], notes: 'n', created_at: CREATED_AT });

    const listed = await listSubject();
    const stored = await saveSubjectFromAdminPage(listed, { roles: [] });

    (stored.roles || []).should.deepEqual([]);
    stored.created_at.should.equal(CREATED_AT);
  });

  it('keeps notes and created_at when a PUT leaves them out', async function () {
    const created = await createSubject({ name: NAME, roles: ['readable'], notes: 'kept', created_at: CREATED_AT });

    const stored = await saveSubject({ _id: created._id.toString(), name: NAME, roles: ['admin'] });

    stored.roles.should.deepEqual(['admin']);
    should(stored.notes).equal('kept');
    stored.created_at.should.equal(CREATED_AT);
  });

  it('clears notes when a PUT sends them empty, and still keeps created_at', async function () {
    const created = await createSubject({ name: NAME, roles: ['readable'], notes: 'to be cleared', created_at: CREATED_AT });

    const stored = await saveSubject({ _id: created._id.toString(), name: NAME, roles: ['readable'], notes: '' });

    stored.notes.should.equal('');
    stored.created_at.should.equal(CREATED_AT);
  });

  async function saveRole (body) {
    await request(self.app)
      .put('/api/v2/authorization/roles')
      .set('api-secret', API_SECRET)
      .send(body)
      .expect(200);

    return rolesCollection().findOne({ name: ROLE });
  }

  async function createRole (body) {
    await request(self.app)
      .post('/api/v2/authorization/roles')
      .set('api-secret', API_SECRET)
      .send(body)
      .expect(200);

    return rolesCollection().findOne({ name: ROLE });
  }

  it('keeps a role\'s notes and created_at when a PUT leaves them out, and clears notes sent empty', async function () {
    const created = await createRole({ name: ROLE, permissions: ['api:entries:read'], notes: 'kept', created_at: CREATED_AT });

    let stored = await saveRole({ _id: created._id.toString(), name: ROLE, permissions: ['api:treatments:read'] });
    stored.permissions.should.deepEqual(['api:treatments:read']);
    should(stored.notes).equal('kept');
    stored.created_at.should.equal(CREATED_AT);

    stored = await saveRole({ _id: created._id.toString(), name: ROLE, permissions: ['api:treatments:read'], notes: '' });
    stored.notes.should.equal('');
    stored.created_at.should.equal(CREATED_AT);
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

  describe('without a name', function () {
    // Without the fix, the TypeError thrown while reloading is an unhandled
    // rejection, which mocha does not report, and the request never answers.
    // Fail the test with that error instead of a timeout.
    let rejected, listener;

    beforeEach(function () {
      rejected = new Promise(function (resolve, reject) { listener = reject; });
      rejected.catch(function () { });
      process.on('unhandledRejection', listener);
    });

    afterEach(function () {
      process.removeListener('unhandledRejection', listener);
    });

    function guarded (work) {
      return Promise.race([work(), rejected]);
    }

    function reloaded () {
      return new Promise(function (resolve, reject) {
        self.ctx.authorization.storage.reload(function loaded (err) {
          return err ? reject(err) : resolve(self.ctx.authorization.storage);
        });
      });
    }

    it('refuses to create a subject without a name, and keeps working', function () {
      return guarded(async function () {
        const refused = await request(self.app)
          .post('/api/v2/authorization/subjects')
          .set('api-secret', API_SECRET)
          .send({ roles: ['readable'], notes: 'no name' })
          .expect(400);

        refused.body.description.should.equal('A name is required');
        (await subjectsCollection().countDocuments(NAMELESS)).should.equal(0);

        // The next write, and the reload that follows it, still work.
        const created = await createSubject({ name: NAME, roles: ['readable'] });
        should.exist(created);
        should.exist(await listSubject());
      });
    });

    it('refuses a subject or role whose name is empty or not a string', function () {
      return guarded(async function () {
        for (const name of ['', '   ', 42, ['a', 'b'], { first: 'x' }]) {
          await request(self.app)
            .post('/api/v2/authorization/subjects')
            .set('api-secret', API_SECRET)
            .send({ name: name, roles: ['readable'] })
            .expect(400);
        }

        await request(self.app)
          .post('/api/v2/authorization/roles')
          .set('api-secret', API_SECRET)
          .send({ permissions: ['api:entries:read'] })
          .expect(400);

        (await subjectsCollection().countDocuments(NAMELESS)).should.equal(0);
        (await rolesCollection().countDocuments(NAMELESS)).should.equal(0);
      });
    });

    it('refuses to save a subject or role without a name', function () {
      return guarded(async function () {
        const created = await createSubject({ name: NAME, roles: ['readable'] });

        await request(self.app)
          .put('/api/v2/authorization/subjects')
          .set('api-secret', API_SECRET)
          .send({ _id: created._id.toString(), roles: ['admin'] })
          .expect(400);

        const stored = await subjectsCollection().findOne({ _id: created._id });
        stored.name.should.equal(NAME);
        stored.roles.should.deepEqual(['readable']);

        const role = await createRole({ name: ROLE, permissions: ['api:entries:read'] });
        await request(self.app)
          .put('/api/v2/authorization/roles')
          .set('api-secret', API_SECRET)
          .send({ _id: role._id.toString(), permissions: ['*'] })
          .expect(400);

        (await rolesCollection().findOne({ _id: role._id })).permissions.should.deepEqual(['api:entries:read']);
      });
    });

    it('loads, skipping subjects and roles already stored without a string name', function () {
      return guarded(async function () {
        await createSubject({ name: NAME, roles: ['readable'] });
        await createRole({ name: ROLE, permissions: ['api:entries:read'] });
        await subjectsCollection().insertMany([
          { roles: ['admin'], created_at: CREATED_AT }
          , { name: 42, roles: ['admin'], created_at: CREATED_AT }
        ]);
        await rolesCollection().insertMany([
          { permissions: ['*'], created_at: CREATED_AT }
          , { name: { first: 'x' }, permissions: ['*'], created_at: CREATED_AT }
        ]);

        const storage = await reloaded();

        storage.subjects.filter(subject => typeof subject.name !== 'string').should.have.length(0);
        storage.roles.filter(role => typeof role.name !== 'string').should.have.length(0);
        should.exist(storage.subjects.find(subject => subject.name === NAME));
        should.exist(storage.roles.find(role => role.name === ROLE));
        should.exist(storage.roles.find(role => role.name === 'admin'));
        should.exist((await listSubject()).accessToken);
      });
    });
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
