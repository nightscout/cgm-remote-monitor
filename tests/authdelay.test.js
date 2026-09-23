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
  //
  // bf2/auth-hardening: the trust boundary has arrived as TRUST_PROXY, but it is
  // OFF BY DEFAULT (the maintainer's compatibility rule), so with TRUST_PROXY
  // unset -- as it is in this describe -- the gap is still there and this test
  // still asserts it, unchanged. The positive assertion is in "... with
  // TRUST_PROXY configured" below.
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

// bf2/auth-hardening. The same attack as the gap test above, against a server
// that has been told which proxy to trust. Each describe boots its own server,
// because TRUST_PROXY is read once at startup.
function bootThrottledServer (self, trustProxy) {
  return function boot (done) {
    const api = require('../lib/api/');
    process.env.API_SECRET = PASSPHRASE;
    process.env.HOSTNAME = 'localhost';
    self.env = require('../lib/server/env')();
    self.env.trustProxy = trustProxy;
    self.env.settings.authDefaultRoles = 'denied';
    self.env.settings.authFailDelay = FAIL_DELAY;
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.app.use('/api/v1', api(self.env, ctx));
      done();
    });
  };
}

function throttleHelpers (self) {
  return {
    reset: async function reset (forwardedFor) {
      let req = request(self.app).get('/api/v1/entries.json').set('api-secret', API_SECRET);
      if (forwardedFor) { req = req.set('X-Forwarded-For', forwardedFor); }
      await req.expect(200);
    }
    , guess: async function guess (secret, forwardedFor) {
      const started = Date.now();
      await request(self.app).get('/api/v1/entries.json')
        .set('api-secret', secret).set('X-Forwarded-For', forwardedFor);
      return Date.now() - started;
    }
  };
}

describe('Authentication failure throttling with TRUST_PROXY configured', function () {
  this.timeout(30000);

  describe('TRUST_PROXY names the proxy in front of Nightscout', function () {
    // The test client connects over loopback, so loopback plays the proxy. A
    // real proxy APPENDS the address it saw to X-Forwarded-For; everything to
    // the left of that is whatever the caller sent.
    const self = {};
    before(bootThrottledServer(self, '127.0.0.1,::1'));
    const t = throttleHelpers(self);
    const REAL = '203.0.113.50';

    it('throttles a guess that varies both the secret and the forwarded address', async function () {
      await t.reset(REAL);

      const first = await t.guess('guess-1', '198.51.100.1, ' + REAL);
      const second = await t.guess('guess-2', '198.51.100.2, ' + REAL);
      const third = await t.guess('guess-3', '198.51.100.3, ' + REAL);

      first.should.be.below(THROTTLED);
      second.should.be.aboveOrEqual(THROTTLED);
      third.should.be.aboveOrEqual(THROTTLED);
    });

    it('keeps a different real client on its own counter', async function () {
      await t.reset(REAL);
      await t.reset('203.0.113.51');

      await t.guess('guess-a', '198.51.100.1, ' + REAL);
      // Different secret, different real client: nothing it has done has failed.
      const other = await t.guess('guess-b', '198.51.100.1, 203.0.113.51');

      other.should.be.below(THROTTLED);
    });
  });

  describe('TRUST_PROXY=false (clients connect directly)', function () {
    const self = {};
    before(bootThrottledServer(self, 'false'));
    const t = throttleHelpers(self);

    it('throttles a guess that varies both the secret and the forwarded address', async function () {
      await t.reset();

      const first = await t.guess('guess-1', '203.0.113.1');
      const second = await t.guess('guess-2', '203.0.113.2');
      const third = await t.guess('guess-3', '203.0.113.3');

      first.should.be.below(THROTTLED);
      second.should.be.aboveOrEqual(THROTTLED);
      third.should.be.aboveOrEqual(THROTTLED);
    });
  });
});

// bf2/auth-hardening. What the throttle is keyed on, through the real request
// path (resolveWithRequest -> resolve), with and without TRUST_PROXY.
describe('Throttle key as the request path resolves it', function () {
  const delaylist = require('../lib/authorization/delaylist');

  function resolvedData (trustProxy, peer, forwardedFor) {
    const saved = { TRUST_PROXY: process.env.TRUST_PROXY, CUSTOMCONNSTR_TRUST_PROXY: process.env.CUSTOMCONNSTR_TRUST_PROXY };
    let env;
    try {
      delete process.env.CUSTOMCONNSTR_TRUST_PROXY;
      if (trustProxy === undefined) { delete process.env.TRUST_PROXY; } else { process.env.TRUST_PROXY = trustProxy; }
      env = require('../lib/server/env')();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
      }
    }
    const authorization = require('../lib/authorization')(env, {
      store: { collection () { return {}; } }, language: { translate: text => text }
    });
    let observed;
    authorization.resolve = data => { observed = data; };
    const req = { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwardedFor }, query: {}, header: () => undefined };
    authorization.resolveWithRequest(req, () => {});
    return observed;
  }

  function addressKey (data) {
    return delaylist({ settings: {} }).keysFor({ ip: data.ip })[0];
  }

  it('with TRUST_PROXY unset, keys on the forwarded header as dev does today', function () {
    const one = resolvedData(undefined, '10.1.0.2', '198.51.100.4');
    const two = resolvedData(undefined, '10.1.0.2', '198.51.100.5');

    one.ip.should.equal('198.51.100.4');
    two.ip.should.equal('198.51.100.5');
    addressKey(one).should.not.equal(addressKey(two));
  });

  it('with TRUST_PROXY naming the peer, keys on the address the proxy saw', function () {
    const one = resolvedData('10.1.0.2', '10.1.0.2', '198.51.100.4, 203.0.113.50');
    const two = resolvedData('10.1.0.2', '10.1.0.2', '198.51.100.5, 203.0.113.50');

    one.ip.should.equal('203.0.113.50');
    addressKey(one).should.equal(addressKey(two));
  });
});

// bf2/auth-hardening. The boot message is the notification half of the
// compatibility decision, so what it says is tested.
describe('Throttle boot message', function () {
  const delaylist = require('../lib/authorization/delaylist');
  const fs = require('node:fs');
  const path = require('node:path');
  const envSource = fs.readFileSync(path.join(__dirname, '../lib/server/env.js'), 'utf8');

  it('with TRUST_PROXY unset, warns and does not claim protection against guessing', function () {
    for (const unset of [undefined, '', '  ']) {
      const message = delaylist.bootMessage({ trustProxy: unset });
      should(message).be.a.String();
      message.should.containEql('TRUST_PROXY');
      message.should.containEql('does NOT protect against guessing');
      // Nothing else in the message may say the delay protects anything.
      message.replace('does NOT protect against guessing', '').should.not.match(/protect/i);
    }
  });

  it('names only settings this branch reads', function () {
    const message = delaylist.bootMessage({});
    const named = message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
    named.length.should.be.above(0);
    for (const name of named) {
      envSource.should.containEql("readENV('" + name + "'");
    }
  });

  it('logs the warning with TRUST_PROXY unset and not once a boundary is named', function () {
    const original = { warn: console.warn, info: console.info };
    const seen = { warn: [], info: [] };
    console.warn = text => seen.warn.push(String(text));
    console.info = text => seen.info.push(String(text));
    try {
      delaylist({ settings: {} });
      delaylist({ settings: {}, trustProxy: '10.1.0.2' });
      delaylist({ settings: {}, trustProxy: 'false' });
    } finally {
      console.warn = original.warn;
      console.info = original.info;
    }
    seen.warn.length.should.equal(1);
    seen.warn[0].should.containEql('TRUST_PROXY is not set');
    seen.info.length.should.equal(2);
    should(delaylist.bootMessage({ trustProxy: '10.1.0.2' })).equal(null);
  });
});
