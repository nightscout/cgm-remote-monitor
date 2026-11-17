/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

// API3_SETTINGS_STRICT_READ_ENABLED: off by default, so reading a settings document by its
// identifier keeps asking for api:settings:read, as it always has. On, it asks for
// api:settings:admin, the permission that search, history and the storage socket already ask
// for on this collection.
describe('API3 settings read permission (API3_SETTINGS_STRICT_READ_ENABLED)', function () {
  const self = this
    , FLAG = 'API3_SETTINGS_STRICT_READ_ENABLED'
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , apiConst = require('../lib/api3/const.json')
    ;

  self.timeout(20000);

  const settingsDoc = {
    identifier: 'test-settings-read-scope',
    date: Date.now(),
    utcOffset: 0,
    app: 'test',
    value: { tested: true }
  };

  const devicestatusDoc = {
    identifier: 'test-settings-read-scope-ds',
    date: Date.now(),
    utcOffset: 0,
    app: 'test',
    device: 'test settings read scope'
  };

  // Tokens: read = api:*:read, readable = *:*:read, admin = api:*:admin, all = api:*:*,
  // denied = no permission at all.
  const TOKENS = ['read', 'readable', 'admin', 'all', 'denied'];

  async function probe (jwt) {
    const settings = await self.instance.get(`/api/v3/settings/${settingsDoc.identifier}`, jwt);
    const devicestatus = await self.instance.get(`/api/v3/devicestatus/${devicestatusDoc.identifier}`, jwt);
    return {
      settings: { status: settings.status, body: settings.text },
      devicestatus: { status: devicestatus.status, body: devicestatus.text }
    };
  }

  async function probeAll () {
    const result = {};
    for (const token of TOKENS) {
      result[token] = await probe(self.jwt[token]);
    }
    return result;
  }

  function setFlag (value) {
    if (value === undefined) {
      self.instance.ctx.apiApp.set(FLAG, apiConst[FLAG]);
    } else {
      self.instance.ctx.apiApp.set(FLAG, value);
    }
  }

  before(async () => {
    self.instance = await instance.create({});
    const auth = await authSubject(self.instance.ctx.authorization.storage
      , TOKENS, self.instance.app);
    self.jwt = auth.jwt;

    await self.instance.post('/api/v3/settings', self.jwt.all).send(settingsDoc).expect(201);
    await self.instance.post('/api/v3/devicestatus', self.jwt.all).send(devicestatusDoc).expect(201);
  });

  after(async () => {
    setFlag(undefined);
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  it('is off unless set', () => {
    apiConst[FLAG].should.equal(false);
    self.instance.ctx.apiApp.get(FLAG).should.equal(false);
  });

  it('off: read by identifier still needs only read permission, byte for byte', async () => {
    setFlag(undefined);
    const unset = await probeAll();
    setFlag(false);
    const off = await probeAll();
    setFlag(undefined);

    // The default and an explicit "off" answer exactly the same, status and body.
    off.should.eql(unset);

    unset.read.settings.status.should.equal(200);
    unset.readable.settings.status.should.equal(200);
    unset.all.settings.status.should.equal(200);
    unset.admin.settings.status.should.equal(403);
    unset.denied.settings.status.should.equal(403);
    JSON.parse(unset.read.settings.body).result.value.should.eql(settingsDoc.value);
  });

  it('on: read by identifier needs the permission search and history ask for', async () => {
    setFlag(true);
    const on = await probeAll();
    setFlag(undefined);

    on.read.settings.status.should.equal(403);
    JSON.parse(on.read.settings.body).message.should.equal('Missing permission api:settings:admin');
    on.readable.settings.status.should.equal(403);
    on.denied.settings.status.should.equal(403);
    on.all.settings.status.should.equal(200);
    on.admin.settings.status.should.equal(200);
    JSON.parse(on.admin.settings.body).result.value.should.eql(settingsDoc.value);
  });

  it('on: the other collections are not affected', async () => {
    const off = await probeAll();
    setFlag(true);
    const on = await probeAll();
    setFlag(undefined);

    for (const token of TOKENS) {
      on[token].devicestatus.should.eql(off[token].devicestatus);
    }
    on.read.devicestatus.status.should.equal(200);
  });

  it('search and history ask for admin either way', async () => {
    for (const value of [false, true]) {
      setFlag(value);
      await self.instance.get('/api/v3/settings', self.jwt.read).expect(403);
      await self.instance.get('/api/v3/settings/history/0', self.jwt.read).expect(403);
      await self.instance.get('/api/v3/settings', self.jwt.admin).expect(200);
    }
    setFlag(undefined);
  });
});


describe('API3 settings read permission, set from the environment', function () {
  const self = this
    , FLAG = 'API3_SETTINGS_STRICT_READ_ENABLED'
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.timeout(20000);

  before(async () => {
    process.env[FLAG] = 'on';
    try {
      self.instance = await instance.create({});
    } finally {
      delete process.env[FLAG];
    }
    const auth = await authSubject(self.instance.ctx.authorization.storage
      , ['read', 'all'], self.instance.app);
    self.jwt = auth.jwt;
    await self.instance.post('/api/v3/settings', self.jwt.all)
      .send({ identifier: 'test-settings-read-scope-env', date: Date.now(), utcOffset: 0, app: 'test' })
      .expect(201);
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  it('turns on with "on" and refuses a read-only token', async () => {
    self.instance.ctx.apiApp.get(FLAG).should.equal(true);
    await self.instance.get('/api/v3/settings/test-settings-read-scope-env', self.jwt.read).expect(403);
    await self.instance.get('/api/v3/settings/test-settings-read-scope-env', self.jwt.all).expect(200);
  });
});
