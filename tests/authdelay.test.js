'use strict';

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

const PASSPHRASE = 'this is my long pass phrase';
// What a client actually sends: the server compares the SHA1 of the passphrase.
const API_SECRET = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

const FAIL_DELAY = 150;
// A throttled request waits FAIL_DELAY; an unthrottled one returns immediately.
// The band between them is wide enough that neither assertion depends on how
// fast the machine is.
const THROTTLED = 120;

describe('Authentication failure throttling', function () {
  const self = this;

  this.timeout(30000);

  before(function (done) {
    const api = require('../lib/api/');
    delete process.env.API_SECRET;
    process.env.API_SECRET = PASSPHRASE;
    process.env.HOSTNAME = 'localhost';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'denied';
    self.env.settings.authFailDelay = FAIL_DELAY;
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.app.use('/api/v1', api(self.env, ctx));
      done();
    });
  });

  // A successful authentication clears the keys it was counted under, which
  // gives each test a known starting point without reaching into the delay list.
  async function resetThrottle () {
    await request(self.app)
      .get('/api/v1/entries.json')
      .set('api-secret', API_SECRET)
      .expect(200);
  }

  async function timeRequest (build) {
    const started = Date.now();
    await build(request(self.app).get('/api/v1/entries.json'));
    return Date.now() - started;
  }

  function wrongSecret (secret, forwardedFor) {
    return function build (req) {
      req = req.set('api-secret', secret);
      return forwardedFor ? req.set('X-Forwarded-For', forwardedFor) : req;
    };
  }

  it('throttles one wrong secret however the forwarded address is varied', async function () {
    await resetThrottle();

    // The address key is defeated here -- each request reports a different one --
    // so it is the CREDENTIAL key that carries this, and that is the point of
    // having two.
    const first = await timeRequest(wrongSecret('wrong-secret', '198.51.100.1'));
    const second = await timeRequest(wrongSecret('wrong-secret', '198.51.100.2'));
    const third = await timeRequest(wrongSecret('wrong-secret', '198.51.100.3'));

    first.should.be.below(THROTTLED);
    second.should.be.aboveOrEqual(THROTTLED);
    third.should.be.aboveOrEqual(THROTTLED);
  });

  // THE GAP THIS RELEASE LEAVES OPEN, PINNED SO NOBODY READS THE OTHERS AS A
  // CLAIM THAT BRUTE FORCE IS SOLVED.
  //
  // Vary the credential AND the reported address together and NOTHING throttles:
  // the credential key is fresh on every guess by definition, and the address
  // key is fresh too because on a default deployment the address is read from
  // request headers the caller controls. Closing it needs a proxy trust boundary
  // so the address becomes one the caller cannot choose. Until then this test
  // asserts the weakness rather than pretending it is absent -- if it starts
  // failing, the trust boundary has arrived and this test should become the
  // positive assertion it replaced.
  it('does NOT yet throttle a guess that varies both the secret and the address', async function () {
    await resetThrottle();

    const first = await timeRequest(wrongSecret('guess-1', '203.0.113.1'));
    const second = await timeRequest(wrongSecret('guess-2', '203.0.113.2'));
    const third = await timeRequest(wrongSecret('guess-3', '203.0.113.3'));

    first.should.be.below(THROTTLED);
    second.should.be.below(THROTTLED);
    third.should.be.below(THROTTLED);
  });

  it('throttles one wrong secret arriving from many addresses', async function () {
    await resetThrottle();

    // The address is the only thing that changes, and the credential key has to
    // carry the throttle on its own for the second and third attempts.
    await timeRequest(wrongSecret('shared-wrong-secret', '192.0.2.1'));
    await resetThrottle();
    const second = await timeRequest(wrongSecret('shared-wrong-secret', '192.0.2.2'));

    second.should.be.aboveOrEqual(THROTTLED);
  });

  it('does not delay a request that authenticates while the address is throttled', async function () {
    await resetThrottle();

    await timeRequest(wrongSecret('wrong-again', '198.51.100.7'));
    await timeRequest(wrongSecret('wrong-again', '198.51.100.8'));

    // The credential entry throttling the guesses above is still live. Making
    // this request wait would mean one failing client could slow down everybody
    // sharing an address, which is what the old code did to every request.
    const authenticated = await timeRequest(function build (req) {
      return req.set('api-secret', API_SECRET).expect(200);
    });

    authenticated.should.be.below(THROTTLED);
  });

  it('does not delay a request that presents no credential at all', async function () {
    await resetThrottle();

    await timeRequest(wrongSecret('wrong-yet-again', '198.51.100.9'));
    await timeRequest(wrongSecret('wrong-yet-again', '198.51.100.10'));

    const anonymous = await timeRequest(function build (req) { return req; });

    anonymous.should.be.below(THROTTLED);
  });
});

describe('Authentication failure delay list', function () {
  const delaylist = require('../lib/authorization/delaylist');

  function build (authFailDelay) {
    return delaylist({ settings: { authFailDelay: authFailDelay } });
  }

  it('keys on the client address as this deployment resolves it', function () {
    const list = build(1000);

    const forged = list.keysFor({ ip: '10.0.0.1', api_secret: 'guess-1' });
    const forgedAgain = list.keysFor({ ip: '10.0.0.1', api_secret: 'guess-2' });

    list.addFailedRequest(forged);
    list.shouldDelayRequest(forgedAgain).should.be.aboveOrEqual(1);
  });

  it('keys on the credential as well, so one secret is throttled across addresses', function () {
    const list = build(1000);

    list.addFailedRequest(list.keysFor({ ip: '10.0.0.1', api_secret: 'same-secret' }));
    const elsewhere = list.keysFor({ ip: '10.0.0.2', api_secret: 'same-secret' });

    list.shouldDelayRequest(elsewhere).should.be.aboveOrEqual(1);
  });

  it('does not hold the credential it was asked to throttle', function () {
    const list = build(1000);
    const secret = 'a-very-recognisable-secret';

    const keys = list.keysFor({ ip: '10.0.0.1', api_secret: secret });

    keys.length.should.equal(2);
    JSON.stringify(keys).should.not.containEql(secret);
    JSON.stringify(keys).should.not.containEql('10.0.0.1');
  });

  it('gives back no keys when there is nothing to key on', function () {
    const list = build(1000);

    list.keysFor(null).should.deepEqual([]);
    list.keysFor({}).should.deepEqual([]);
    should(list.shouldDelayRequest([])).equal(false);
    should(list.shouldDelayRequest(undefined)).equal(false);
  });

  it('clears the keys of a request that succeeded', function () {
    const list = build(1000);
    const keys = list.keysFor({ ip: '10.0.0.1', api_secret: 'secret' });

    list.addFailedRequest(keys);
    list.shouldDelayRequest(keys).should.be.aboveOrEqual(1);

    list.requestSucceeded(keys);
    should(list.shouldDelayRequest(keys)).equal(false);
  });

  it('keeps throttling an address that floods the list with distinct credentials', function () {
    const list = build(1000);
    const addressKeys = list.keysFor({ ip: '10.0.0.1', api_secret: 'first-guess' });

    list.addFailedRequest(addressKeys);

    // Credential keys are the ones an attacker can mint at will. Evicting them
    // must not evict the address entry that is throttling that same attacker.
    for (let i = 0; i < 20000; i++) {
      list.addFailedRequest(list.keysFor({ api_secret: 'flood-' + i }));
    }

    list.shouldDelayRequest(addressKeys).should.be.aboveOrEqual(1);
  });
});
