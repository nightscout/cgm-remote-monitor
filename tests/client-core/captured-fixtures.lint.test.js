'use strict';

/*
 * tests/client-core/captured-fixtures.lint.test.js
 *
 * Guards against PII regressions and shape drift in the captured
 * fixture set under tests/fixtures/captured/. These fixtures are
 * committed to the repo and consumed by client-core unit tests;
 * any leak of a real device serial, push token, or original Mongo
 * _id would be a privacy incident.
 *
 * Runs as part of `npm run test:core` (Node-only, no jsdom).
 *
 * Layout:
 *   tests/fixtures/captured/
 *     loop/{entries,treatments,devicestatus,profile}.json
 *     trio/{treatments,devicestatus}.json
 *     phone-uploader/{treatments,devicestatus}.json
 */

require('should');
var fs = require('fs');
var path = require('path');

var FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'captured');

// Per-source layout. Each entry lists which collections to expect
// and what the size envelope is. Sources may legitimately omit
// collections that aren't useful (e.g. trio/ has no entries.json
// because the SGV records for that patient aren't fixture-worthy).
var SOURCES = {
  loop: {
    entries:      { required: true,  maxBytes: 110000 }
    , treatments:   { required: true,  maxBytes: 60000 }
    , devicestatus: { required: true,  maxBytes: 100000 }
    , profile:      { required: true,  maxBytes: 60000 }
  }
  , trio: {
    entries:      { required: false }
    , treatments:   { required: true,  maxBytes: 40000 }
    , devicestatus: { required: true,  maxBytes: 100000 }
    , profile:      { required: false }
  }
  , 'phone-uploader': {
    entries:      { required: false }
    , treatments:   { required: true,  maxBytes: 20000 }
    , devicestatus: { required: true,  maxBytes: 15000 }
    , profile:      { required: false }
  }
  , aaps: {
    entries:      { required: false }
    , treatments:   { required: true,  maxBytes: 30000 }
    , devicestatus: { required: true,  maxBytes: 110000 }
    , profile:      { required: false }
  }
};

function load (source, name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, source, name), 'utf8'));
}

// Tokens that must NEVER appear in any committed fixture file.
// Drawn from the original three captures; if any sanitization step
// regresses, these strings will reappear and the lint fails loudly.
var BANNED_TOKENS = [
  '8XRSC5'                 // Dexcom serial fragment from loop source
  , '208850'               // Pump ID from loop source
  , 'loop://iPhone'        // Loop uploader → loop://test-device
  , '227ec1986a9a6281'     // Loop deviceToken prefix
  , 'medicaldatanetworks'  // Loop bundleIdentifier fragment
  , 'Sony SO-53B'          // phone-uploader device → 'Android Phone'
];

var SUSPICIOUS_PATTERNS = [
  { name: 'long-uppercase-alnum', re: /\b[A-Z][A-Z0-9]{6,}\b/g }
  , { name: 'long-numeric-id', re: /\b\d{8,}\b/g }
];

var ALLOW_LIST = [
  'SERIAL'           // sanitizer placeholder (tools/captured-fixtures/sanitize.js)
  , 'AndroidAPS'     // legitimate AAPS device label
  , 'Trio'           // legitimate uploader label
  , 'OpenAPS'        // legitimate label
  , 'Loop'           // legitimate label
  , '2026030500'     // Loop app fixture build/version number, not a device identifier
  , '3735928559'     // Trio reservoir sentinel (0xDEADBEEF), not a device identifier
];

function isUuidFragment (raw, index, match) {
  var start = index;
  var end = index + match.length;
  while (start > 0 && /[A-F0-9-]/.test(raw[start - 1])) start--;
  while (end < raw.length && /[A-F0-9-]/.test(raw[end])) end++;
  return /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/.test(raw.slice(start, end));
}

function isDecimalTail (raw, index, match) {
  return raw[index - 1] === '.' || raw[index + match.length] === '.';
}

function isAllowed (match, raw, index) {
  if (/^[0-9a-f]{24}$/.test(match)) return true;
  if (/^\d{13,}$/.test(match) && (match[0] === '1' || match[0] === '2')) return true;
  if (isUuidFragment(raw, index, match)) return true;
  if (/^\d+$/.test(match) && isDecimalTail(raw, index, match)) return true;
  for (var i = 0; i < ALLOW_LIST.length; i++) {
    if (match.indexOf(ALLOW_LIST[i]) !== -1) return true;
  }
  return false;
}

describe('captured fixtures lint', function () {

  Object.keys(SOURCES).forEach(function (source) {
    var spec = SOURCES[source]; // eslint-disable-line security/detect-object-injection

    describe(source + '/', function () {

      Object.keys(spec).forEach(function (col) {
        var meta = spec[col]; // eslint-disable-line security/detect-object-injection
        var name = col + '.json';
        var file = path.join(FIXTURE_ROOT, source, name);
        var exists = fs.existsSync(file);

        if (meta.required) {
          it(name + ' exists', function () {
            exists.should.be.true(file);
          });
        }

        if (!exists) return;

        it(name + ' contains no banned tokens', function () {
          var raw = fs.readFileSync(file, 'utf8');
          BANNED_TOKENS.forEach(function (tok) {
            raw.indexOf(tok).should.equal(-1, 'banned token "' + tok + '" in ' + source + '/' + name);
          });
        });

        it(name + ' contains no unrecognized suspicious PII shapes', function () {
          var raw = fs.readFileSync(file, 'utf8');
          SUSPICIOUS_PATTERNS.forEach(function (pattern) {
            var match;
            pattern.re.lastIndex = 0;
            while ((match = pattern.re.exec(raw)) !== null) {
              isAllowed(match[0], raw, match.index).should.equal(
                true,
                'suspicious ' + pattern.name + ' "' + match[0] + '" in ' + source + '/' + name
              );
            }
          });
        });

        if (meta.maxBytes) {
          it(name + ' stays under ' + meta.maxBytes + ' bytes', function () {
            fs.statSync(file).size.should.be.lessThan(meta.maxBytes);
          });
        }
      });

      // Cross-collection shape assertions per source.
      if (spec.entries && spec.entries.required) {
        it('every entry has _id, date, type', function () {
          load(source, 'entries.json').forEach(function (e) {
            e._id.should.match(/^[0-9a-f]{24}$/);
            e.should.have.property('type');
            e.should.have.property('date').which.is.a.Number();
          });
        });
      }
      if (spec.treatments && spec.treatments.required) {
        it('every treatment has _id, eventType, created_at', function () {
          load(source, 'treatments.json').forEach(function (t) {
            t._id.should.match(/^[0-9a-f]{24}$/);
            t.should.have.property('eventType');
            t.should.have.property('created_at');
          });
        });
      }
      if (spec.devicestatus && spec.devicestatus.required) {
        it('every devicestatus has _id, created_at, device', function () {
          load(source, 'devicestatus.json').forEach(function (d) {
            d._id.should.match(/^[0-9a-f]{24}$/);
            d.should.have.property('created_at');
            d.should.have.property('device');
          });
        });
      }
      if (spec.profile && spec.profile.required) {
        it('profile records have store + defaultProfile', function () {
          load(source, 'profile.json').forEach(function (p) {
            p._id.should.match(/^[0-9a-f]{24}$/);
            p.should.have.property('defaultProfile');
            p.should.have.property('store').which.is.an.Object();
          });
        });
      }
    });
  });

  describe('time anchor (loop fixtures)', function () {
    it('latest loop entry lands at the documented reference epoch (within tolerance)', function () {
      var sanitize = require('../../tools/captured-fixtures/sanitize');
      var entries = load('loop', 'entries.json');
      var latest = entries.reduce(function (acc, e) { return Math.max(acc, e.date || 0); }, 0);
      var dayMs = 24 * 60 * 60 * 1000;
      Math.abs(latest - sanitize.TARGET_LATEST_EPOCH).should.be.lessThan(dayMs);
    });
  });

  describe('determinism (sanitizer is pure)', function () {
    var sanitize = require('../../tools/captured-fixtures/sanitize');

    it('sanitizeEntry produces stable _id for stable input', function () {
      var input = {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa'
        , date: 1700000000000
        , dateString: '2023-11-14T22:13:20.000Z'
        , type: 'sgv'
        , sgv: 120
        , device: 'Dexcom G6 ABC123'
        , direction: 'Flat'
      };
      var shifter = sanitize.makeShifter(0);
      var a = sanitize.sanitizeEntry(input, shifter);
      var b = sanitize.sanitizeEntry(input, shifter);
      a.should.eql(b);
      a.device.should.equal('Dexcom G6 SERIAL');
      a._id.should.match(/^[0-9a-f]{24}$/);
      a._id.should.not.equal('aaaaaaaaaaaaaaaaaaaaaaaa');
    });
  });
});
