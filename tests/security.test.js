'use strict';

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();
//const io = require('socket.io-client');

describe('API_SECRET', function() {
  var api;
  var scope = this;
  var websocket;
  var app;
  var server;
  var listener;

  this.timeout(7000);

  afterEach(function(done) {
    if (listener) {
      listener.close(done);
    }
    done();
  });

  after(function(done) {
    if (listener) {
      listener.close(done);
    }
    done();
  });

  function setup_app (env, fn) {
    api = require('../lib/api/');
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      ctx.app = api(env, ctx);
      scope.app = ctx.app;
      scope.entries = ctx.entries;
      fn(ctx);
    });
  }

  function setup_big_app (env, fn) {
    api = require('../lib/api/');
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      ctx.app = api(env, ctx);
      scope.app = ctx.app;
      scope.entries = ctx.entries;

      app = require('../lib/server/app')(env, ctx);
      server = require('http').createServer(app);
      listener = server.listen(1337, 'localhost');
      websocket = require('../lib/server/websocket')(env, ctx, server);

      fn(ctx);
    });
  }

  it('should fail when unauthorized', function(done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')();

    env.enclave.isApiKey(known).should.equal(true);

    setup_app(env, function(ctx) {
      ctx.app.enabled('api').should.equal(true);
      ping_status(ctx.app, again);

      function again () {
        ctx.app.api_secret = '';
        ping_authorized_endpoint(ctx.app, 401, done);
      }
    });

  });

  it('should work fine set', function(done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')();
    env.enclave.isApiKey(known).should.equal(true);
    setup_app(env, function(ctx) {
      ctx.app.enabled('api').should.equal(true);
      ping_status(ctx.app, again);

      function again () {
        ctx.app.api_secret = known;
        ping_authorized_endpoint(ctx.app, 200, done);
      }
    });

  });

  it('should not work short', function() {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'tooshort';
    var env = require('../lib/server/env')();
    should.not.exist(env.api_secret);
    env.err[0].desc.should.startWith('API_SECRET should be at least');
  });

  function ping_status (app, fn) {
    request(app)
      .get('/status.json')
      .expect(200)
      .end(function(err, res) {
        res.body.status.should.equal('ok');
        fn();
      });
  }

  function ping_authorized_endpoint (app, fails, fn) {
    request(app)
      .get('/experiments/test')
      .set('api-secret', app.api_secret || '')
      .expect(fails)
      .end(function(err, res) {
        if (fails < 400) {
          res.body.status.should.equal('ok');
        }
        fn();
      });
  }

  /*
  it('socket IO should connect', function(done) {

    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')();

    setup_big_app(env, function(ctx) {

      const socket2 = io.connect('ws://localhost:1337/');

      socket2.on('connect', function() {
        console.log('Socket 2 authorizing');
        socket2.emit("authorize", {
          secret: known
        });
      });

      socket2.on('disconnect', function() {
        //socket.emit("authorize");
        console.log('Client 2 disconnected');
        done();
      });

      socket2.on('connected', function(msg) {
        console.log('Connected');

        // Disconnect both client connections
        socket2.disconnect();

        const socket = io.connect('ws://localhost:1337/');

        socket.on('connect', function() {
          console.log('Socket 1 authorizing');
          socket.emit("authorize");
        });

        socket.on('disconnect', function() {
          //socket.emit("authorize");
          console.log('Client 1 disconnected');
          done();
        });

      });

    });

  });
  */

});

describe('purifier', function() {

  it('sanitizes nested strings and leaves primitive non-strings alone', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {
      note: '<script>alert(1)</script>safe'
      , nested: {
        html: '<img src=x onerror="alert(1)"><strong>ok</strong>'
      }
      , count: 5
    };

    purifier.purifyObject(record);

    record.note.should.equal('safe');
    record.nested.html.should.not.containEql('onerror');
    record.nested.html.should.containEql('<strong>ok</strong>');
    record.count.should.equal(5);
  });

  it('removes unsafe URL attributes from HTML strings', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {
      note: '<a href="javascript:alert(1)">open</a>'
    };

    purifier.purifyObject(record);

    record.note.should.not.containEql('javascript:');
    record.note.should.containEql('open');
  });

  it('preserves harmless text and profile references byte-for-byte', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {
      defaultProfile: 'A&B',
      status: 'BG < 70',
      store: {
        'A&B': {
          name: 'Fish & Chips'
        }
      }
    };

    purifier.purifyObject(record);

    record.defaultProfile.should.equal('A&B');
    record.status.should.equal('BG < 70');
    Object.keys(record.store).should.deepEqual(['A&B']);
    record.store['A&B'].name.should.equal('Fish & Chips');
  });

  it('does not expand large plain-text strings during sanitization', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var text = '&'.repeat(1024 * 1024);
    var record = {note: text};

    purifier.purifyObject(record);

    record.note.should.equal(text);
  });

  it('rejects oversized strings that require HTML parsing', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {note: '<b>' + 'x'.repeat(64 * 1024)};

    (function () {
      purifier.purifyObject(record);
    }).should.throw(/sanitization limit/);
  });

  it('bounds aggregate HTML parsing across an object', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var markup = '<b>' + 'x'.repeat(32 * 1024);
    var record = {first: markup, second: markup};

    (function () {
      purifier.purifyObject(record);
    }).should.throw(/sanitization limit/);
  });

  it('sanitizes reasonably deep input without exhausting the call stack', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {};
    var leaf = record;

    for (var depth = 0; depth < 512; depth += 1) {
      leaf.child = {};
      leaf = leaf.child;
    }
    leaf.note = '<script>alert(1)</script>safe';

    purifier.purifyObject(record);

    leaf.note.should.equal('safe');
  });

  it('rejects excessive nesting before traversal state can exhaust the heap', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {};
    var leaf = record;

    for (var depth = 0; depth < 1100; depth += 1) {
      leaf.child = {};
      leaf = leaf.child;
    }

    (function () {
      purifier.purifyObject(record);
    }).should.throw(/complexity limit/);
  });

  it('rejects excessive object and property counts', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var tooManyObjects = [];
    var tooManyProperties = {};

    for (var index = 0; index < 11000; index += 1) {
      tooManyObjects.push({});
    }
    for (var property = 0; property < 52000; property += 1) {
      tooManyProperties['key' + property] = 'plain text';
    }

    (function () {
      purifier.purifyObject(tooManyObjects);
    }).should.throw(/complexity limit/);
    (function () {
      purifier.purifyObject(tooManyProperties);
    }).should.throw(/complexity limit/);
  });

  it('is idempotent when a write crosses more than one guarded boundary', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = {
      note: '<img src=x onerror=alert(1)><strong>A&B</strong>',
      encoded: '&lt;img src=x onerror=alert(1)&gt;'
    };

    purifier.purifyObject(record);
    var once = JSON.stringify(record);
    purifier.purifyObject(record);

    JSON.stringify(record).should.equal(once);
  });

  it('sanitizes own prototype-like keys without polluting global prototypes', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var record = JSON.parse('{"__proto__":{"note":"<script>alert(1)</script>safe"},"constructor":{"note":"<img src=x onerror=alert(1)>ok"},"prototype":{"note":"<script>alert(1)</script>done"}}');

    purifier.purifyObject(record);

    record.__proto__.note.should.equal('safe');
    record.constructor.note.should.not.match(/onerror/i);
    record.prototype.note.should.equal('done');
    should.not.exist(Object.prototype.note);
  });

  it('purifies direct storage batches per document and fails closed without a purifier', function() {
    var purifyForStorage = require('../lib/server/storage-purifier');
    var purifier = require('../lib/server/purifier')({}, {});
    var documents = [
      {note: '<script>alert(1)</script>first'},
      {note: '<img src=x onerror=alert(1)>second'}
    ];

    purifyForStorage({purifier: purifier}, documents);

    documents[0].note.should.equal('first');
    documents[1].note.should.not.match(/onerror/i);
    (function () {
      purifyForStorage({}, {note: 'must not be written'});
    }).should.throw(/not configured/);
  });

  it('keeps disabled SVG, form and raw-text parser features inert', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var JSDOM = require('jsdom').JSDOM;
    var payloads = [
      '<svg><a><animate attributeName="href" values="#safe;javascript:alert(\'XSS\')" dur=".01s" fill="freeze"></animate><text y="30">Click me</text></a></svg>',
      '<button formaction="javascript:alert(1)">Submit</button>',
      '<object data="javascript:alert(1)"></object>',
      '<textarea><img src=x onerror=alert(1)></textarea>SAFE',
      '<xmp><img src=x onerror=alert(1)></xmp>SAFE',
      '<textarea></textarea/><img src=x onerror="alert(document.domain)">',
      '<xmp></xmp/><img src=x onerror="alert(document.domain)">',
      '<svg><textarea><img src=x onerror=alert(1)>',
      '<svg><xmp><img src=x onerror=alert(1)>',
      '<math><textarea><img src=x onerror=alert(1)>',
      '<math><xmp><img src=x onerror=alert(1)>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--></mglyph><img src=1 onerror=alert(1)>">'
    ];

    payloads.forEach(function (payload) {
      var markup = purifier.sanitizeString(payload);

      // Mutation-XSS payloads can become dangerous only after the browser
      // reparses a sanitizer result. Check multiple parse/serialize rounds.
      for (var round = 0; round < 3; round += 1) {
        var dom = new JSDOM('<!doctype html><body>' + markup + '</body>');
        var body = dom.window.document.body;

        body.querySelectorAll('svg, animate, set, form, button, object, textarea, xmp, math, script, iframe, embed')
          .length.should.equal(0);
        body.querySelectorAll('*').forEach(function (element) {
          Array.from(element.attributes).forEach(function (attribute) {
            attribute.name.should.not.match(/^on/i);
            if (/^(?:href|src|srcset|action|formaction|data|srcdoc)$/i.test(attribute.name)) {
              attribute.value.should.not.match(/^\s*(?:javascript|vbscript):/i);
            }
          });
        });

        markup = body.innerHTML;
        dom.window.close();
      }
    });
  });

  it('handles cycles and leaves date and binary values untouched', function() {
    var purifier = require('../lib/server/purifier')({}, {});
    var date = new Date('2025-01-01T00:00:00.000Z');
    var buffer = Buffer.from('binary');
    var typedArray = new Uint8Array([1, 2, 3]);
    var unsafe = '<script>alert(1)</script>';
    var record = {
      list: [unsafe + 'safe'],
      date: date,
      buffer: buffer,
      typedArray: typedArray
    };

    date.note = unsafe;
    buffer.note = unsafe;
    typedArray.note = unsafe;
    record.self = record;
    record.list.push(record);

    purifier.purifyObject(record);

    record.list[0].should.equal('safe');
    record.self.should.equal(record);
    record.list[1].should.equal(record);
    date.note.should.equal(unsafe);
    buffer.note.should.equal(unsafe);
    typedArray.note.should.equal(unsafe);
  });

});
