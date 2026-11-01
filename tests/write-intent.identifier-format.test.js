'use strict';

// identifier-format (ID-FIRST-MATCH slice 2, ID-VALIDATE; ID-Q6,
// ID-PLACEHOLDER-LIST, BF-215, BF-216): which `identifier` values are
// identifiers, the WRITE_IDENTIFIER setting, and the rule as each path's
// step applies it. The API, socket and v3 replies are in
// tests/api.identifier-format.test.js.
//
// Synthetic values only.

const assert = require('node:assert/strict');

const writeIntent = require('../lib/storage/write-intent');
const writeSettings = require('../lib/server/write-settings');

const ID = 'f1d2c3b4-0000-4000-8000-00000000c001';

// Every value the rule treats as absent, by class.
const ABSENT = [
  ['placeholder', 'undefined'], ['placeholder', 'Undefined'], ['placeholder', 'UNDEFINED']
  , ['placeholder', 'null'], ['placeholder', 'NULL'], ['placeholder', 'Null']
  , ['placeholder', 'invalid'], ['placeholder', 'Invalid'], ['placeholder', 'INVALID']
  , ['placeholder', 'NaN'], ['placeholder', 'nan'], ['placeholder', 'NAN']
  , ['placeholder', 'unknown'], ['placeholder', 'Unknown'], ['placeholder', 'UNKNOWN']
  , ['blank', ''], ['blank', ' '], ['blank', '   '], ['blank', '\t\n ']
  , ['over-length', 'x'.repeat(257)], ['over-length', 'é'.repeat(300)]
  , ['null', null]
  , ['not-a-string', 1714000000000], ['not-a-string', 0], ['not-a-string', true], ['not-a-string', false]
  , ['not-a-string', { $ne: null }], ['not-a-string', [ID]]
];

// Values that are identifiers: any string of 1 to 256 characters that is not
// a placeholder, whatever its characters.
const VALID = [ID, 'x', 'x'.repeat(256), 'glooko:bolus:' + 'a'.repeat(64), 'a/b c', 'ü€😀', 'undefined-1', 'nullable'
  , ' x ', 'unknownx'];

function withWarnings (work) {
  const lines = [ ];
  const warn = console.warn;
  console.warn = function capture (line) { lines.push(String(line)); };
  try {
    work();
  } finally {
    console.warn = warn;
  }
  return lines;
}

function v1Plan (doc, env) {
  return writeIntent.forCollection({ }, 'treatments', 'v1/internal', { env: Object.assign({ uuidHandling: true }, env) })
    .plan({ op: 'create', form: 'batch', docs: [doc] });
}

describe('identifier-format: which values are identifiers (ID-Q6)', function ( ) {

  it('the placeholder list is the decided one (ID-PLACEHOLDER-LIST), compared without regard to case', function ( ) {
    assert.deepStrictEqual(writeIntent.PLACEHOLDER_IDENTIFIERS.slice(), ['undefined', 'null', 'invalid', 'nan', 'unknown']);
    assert.equal(writeIntent.IDENTIFIER_MAX_LENGTH, 256);
  });

  ABSENT.forEach(function ([kind, value]) {
    const label = typeof value === 'string' && value.length > 20 ? value.length + ' characters' : JSON.stringify(value);
    it('treats ' + label + ' as absent (' + kind + ')', function ( ) {
      assert.equal(writeIntent.identifierClass(value), kind);
      assert.equal(writeIntent.isValidIdentifier(value), false);
    });
  });

  VALID.forEach(function (value) {
    const label = value.length > 20 ? value.length + ' characters' : JSON.stringify(value);
    it('accepts ' + label, function ( ) {
      assert.equal(writeIntent.identifierClass(value), 'valid');
      assert.equal(writeIntent.isValidIdentifier(value), true);
    });
  });
});

describe('WRITE_IDENTIFIER and WRITE_VALIDATION: one parse (lib/server/write-settings.js)', function ( ) {

  function parsed (values) {
    return writeSettings.parse(function read (name, fallback) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
    });
  }

  // CHANGED EXPECTATION (maintainer 2026-10-31, compat card A, option (i)): WRITE_IDENTIFIER
  // unset is its own mode, `default` (API v3 refuses a whitespace-only or
  // numeric identifier, as 15.0.9 did); it was `lenient`.
  it('defaults to the unset identifier mode and off', function ( ) {
    const result = parsed({ });
    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 3, ID-Q3): the parse also
    // holds WRITE_DELETED_EDIT, `ignore` by default.
    // CHANGED EXPECTATION (ID-UNIQUE-INDEX and ID-RESEND-SWITCH): index
    // (`try`) and re-send settings (`replace`, `stay`) are added.
    assert.deepStrictEqual(result.write, { validation: 'off', identifier: 'default', deletedEdit: 'ignore'
      , index: 'try', resend: 'replace', deletedResend: 'stay' });
    assert.deepStrictEqual(result.errors, [ ]);
  });

  it('reads strict and lenient, without regard to case or surrounding space', function ( ) {
    assert.equal(parsed({ WRITE_IDENTIFIER: 'strict' }).write.identifier, 'strict');
    assert.equal(parsed({ WRITE_IDENTIFIER: ' STRICT ' }).write.identifier, 'strict');
    assert.equal(parsed({ WRITE_IDENTIFIER: 'Lenient' }).write.identifier, 'lenient');
    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card A, option (i)): empty is unset,
    // the `default` mode; it was `lenient`.
    assert.equal(parsed({ WRITE_IDENTIFIER: '' }).write.identifier, 'default');
  });

  it('an unknown WRITE_IDENTIFIER is an error, so the server refuses to start', function ( ) {
    const result = parsed({ WRITE_IDENTIFIER: 'refuse' });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /WRITE_IDENTIFIER must be one of lenient, strict/);
  });

  it('WRITE_IDENTIFIER_INDEX reads try, require and off; anything else is an error (ID-UNIQUE-INDEX)', function ( ) {
    assert.equal(parsed({ WRITE_IDENTIFIER_INDEX: 'require' }).write.index, 'require');
    assert.equal(parsed({ WRITE_IDENTIFIER_INDEX: ' OFF ' }).write.index, 'off');
    assert.equal(parsed({ WRITE_IDENTIFIER_INDEX: '' }).write.index, 'try');
    const result = parsed({ WRITE_IDENTIFIER_INDEX: 'on' });
    assert.equal(result.write.index, 'try');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /WRITE_IDENTIFIER_INDEX must be one of try, require, off/);
    assert.equal(writeSettings.indexMode({ }), 'try');
    assert.equal(writeSettings.indexMode({ write: { index: 'off' } }), 'off');
  });

  it('WRITE_VALIDATION is parsed as before: any other value is off', function ( ) {
    assert.equal(parsed({ WRITE_VALIDATION: 'reject' }).write.validation, 'reject');
    assert.equal(parsed({ WRITE_VALIDATION: ' Log ' }).write.validation, 'log');
    assert.equal(parsed({ WRITE_VALIDATION: 'bogus' }).write.validation, 'off');
    assert.deepStrictEqual(parsed({ WRITE_VALIDATION: 'bogus' }).errors, [ ]);
  });

  it('env.js sets env.write and keeps env.writeValidation from the same parse', function ( ) {
    const saved = { WRITE_IDENTIFIER: process.env.WRITE_IDENTIFIER, WRITE_IDENTIFIER_INDEX: process.env.WRITE_IDENTIFIER_INDEX
      , WRITE_VALIDATION: process.env.WRITE_VALIDATION };
    try {
      process.env.WRITE_IDENTIFIER = 'strict';
      process.env.WRITE_IDENTIFIER_INDEX = 'try';
      process.env.WRITE_VALIDATION = 'log';
      let env = require('../lib/server/env')();
      // CHANGED EXPECTATION (ID-FIRST-MATCH slice 3, ID-Q3): WRITE_DELETED_EDIT too.
      // CHANGED EXPECTATION (ID-UNIQUE-INDEX and ID-RESEND-SWITCH): index,
      // WRITE_RESEND and WRITE_DELETED_RESEND are parsed at boot.
      assert.deepStrictEqual(env.write, { validation: 'log', identifier: 'strict', deletedEdit: 'ignore'
        , index: 'try', resend: 'replace', deletedResend: 'stay' });
      assert.equal(env.writeValidation, 'log');
      assert.equal(env.err.length, 0);

      process.env.WRITE_IDENTIFIER = 'sometimes';
      env = require('../lib/server/env')();
      assert.equal(env.write.identifier, 'lenient');
      assert.equal(env.err.filter(function (e) { return /WRITE_IDENTIFIER/.test(e.desc); }).length, 1);
    } finally {
      Object.keys(saved).forEach(function (name) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      });
    }
  });

  // CHANGED EXPECTATION (maintainer 2026-10-31, compat card A, option (i)): an env without
  // the setting is the setting left unset, the `default` mode; it was `lenient`.
  it('identifierMode is the unset mode for an env without the setting', function ( ) {
    assert.equal(writeSettings.identifierMode({ }), 'default');
    assert.equal(writeSettings.identifierMode(undefined), 'default');
    assert.equal(writeSettings.identifierMode({ write: { identifier: 'lenient' } }), 'lenient');
    assert.equal(writeSettings.identifierMode({ write: { identifier: 'strict' } }), 'strict');
  });
});

describe('identifier-format in the step', function ( ) {

  describe('identifiers(): the rule where a route can still refuse', function ( ) {

    ['v1/internal', 'socket', 'v3'].forEach(function (source) {
      it(source + ', lenient: an invalid identifier is removed, and the warning names path, collection and class, not the value', function ( ) {
        const docs = [{ identifier: 'Unknown', carbs: 1 }, { identifier: ID }, { carbs: 2 }, { identifier: 42 }];
        let refused;
        const lines = withWarnings(function ( ) {
          refused = writeIntent.forCollection({ }, 'treatments', source, { env: { write: { identifier: 'lenient' } } })
            .identifiers(docs);
        });
        assert.deepStrictEqual(refused, [ ]);
        assert.deepStrictEqual(docs, [{ carbs: 1 }, { identifier: ID }, { carbs: 2 }, { }]);
        assert.deepStrictEqual(lines, [
          'WRITE_IDENTIFIER ' + source + ' treatments: identifier treated as absent, placeholder'
          , 'WRITE_IDENTIFIER ' + source + ' treatments: identifier treated as absent, not-a-string (number)'
        ]);
        lines.forEach(function (line) { assert.doesNotMatch(line, /Unknown|42/); });
      });
    });

    ['socket', 'v3'].forEach(function (source) {
      it(source + ', strict: an invalid identifier is refused, and the document is left as sent', function ( ) {
        const docs = [{ identifier: ID }, { identifier: '   ', carbs: 1 }, { identifier: null }];
        let refused;
        withWarnings(function ( ) {
          refused = writeIntent.forCollection({ }, 'entries', source, { env: { write: { identifier: 'strict' } } })
            .identifiers(docs);
        });
        assert.deepStrictEqual(refused, [
          { index: 1, problems: [{ rule: 'identifier-format', field: 'identifier', message: 'identifier is empty' }] }
          , { index: 2, problems: [{ rule: 'identifier-format', field: 'identifier', message: 'identifier is null' }] }
        ]);
        assert.deepStrictEqual(docs, [{ identifier: ID }, { identifier: '   ', carbs: 1 }, { identifier: null }]);
      });
    });

    // open: ID-STRICT-V1. API v1 and in-process callers have no per-document
    // identifier refusal yet, so strict treats the value as absent there.
    it('v1/internal, strict: not enforced yet; the identifier is treated as absent', function ( ) {
      const docs = [{ identifier: 'invalid' }];
      let refused;
      withWarnings(function ( ) {
        refused = writeIntent.forCollection({ }, 'food', 'v1/internal', { env: { write: { identifier: 'strict' } } })
          .identifiers(docs);
      });
      assert.deepStrictEqual(refused, [ ]);
      assert.deepStrictEqual(docs, [{ }]);
    });
  });

  describe('after the _id step: a placeholder never matches a stored record', function ( ) {

    it('v1 treatments: a placeholder identifier is matched by the fallback key, not by identifier, and not stored', function ( ) {
      let planned;
      withWarnings(function ( ) {
        planned = v1Plan({ identifier: 'NULL', eventType: 'Meal Bolus', carbs: 10, created_at: '2019-05-11T07:40:00.000Z' });
      });
      assert.equal(Object.prototype.hasOwnProperty.call(planned.docs[0], 'identifier'), false);
      assert.deepStrictEqual(planned.targets[0].created_at, { $eq: '2019-05-11T07:40:00.000Z' });
      assert.deepStrictEqual(planned.targets[0].identifier, { $in: [null, ''], $not: { $type: 'array' } });
    });

    it('v1 treatments: a valid identifier is still matched on (control)', function ( ) {
      const planned = v1Plan({ identifier: ID, eventType: 'Meal Bolus', carbs: 10, created_at: '2019-05-11T07:40:00.000Z' });
      assert.equal(planned.docs[0].identifier, ID);
      assert.deepStrictEqual(planned.targets[0], { $or: [{ identifier: { $eq: ID } }, { _id: { $eq: ID } }] });
    });

    it('v1 treatments: a placeholder _id that UUID_HANDLING moves into identifier is caught after the move', function ( ) {
      let planned;
      const lines = withWarnings(function ( ) {
        planned = v1Plan({ _id: 'undefined', eventType: 'Note', created_at: '2019-05-11T07:40:00.000Z' });
      });
      assert.equal(Object.prototype.hasOwnProperty.call(planned.docs[0], '_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(planned.docs[0], 'identifier'), false);
      assert.equal(planned.targets[0].$or, undefined);
      assert.deepStrictEqual(lines, ['WRITE_IDENTIFIER v1/internal treatments: identifier treated as absent, placeholder']);
    });

    it('v1 treatments: a numeric identifier is treated as absent (BF-215), not refused', function ( ) {
      let planned;
      withWarnings(function ( ) {
        planned = v1Plan({ identifier: 1714000000000, eventType: 'Note', created_at: '2019-05-11T07:40:00.000Z' });
      });
      assert.equal(Object.prototype.hasOwnProperty.call(planned.docs[0], 'identifier'), false);
    });

    it('v1 entries: an over-length identifier is not matched on and not stored', function ( ) {
      let planned;
      withWarnings(function ( ) {
        planned = writeIntent.forCollection({ }, 'entries', 'v1/internal', { env: { uuidHandling: true } })
          .plan({ op: 'create', docs: [{ identifier: 'x'.repeat(257), type: 'sgv', sgv: 100, date: 1557560400000 }] });
      });
      assert.equal(Object.prototype.hasOwnProperty.call(planned.docs[0], 'identifier'), false);
      assert.deepStrictEqual(Object.keys(planned.ops[0].updateOne.filter).sort(), ['sysTime', 'type']);
    });

    it('v1 devicestatus: a placeholder identifier asks storage for no identifier match', async function ( ) {
      const calls = [ ];
      const storage = {
        findFiltered: async function (filter) { calls.push(['findFiltered', JSON.stringify(filter)]); return [ ]; },
        insertMany: async function (docs) {
          calls.push(['insertMany', docs.length]);
          return { insertedIds: docs.reduce(function (ids, doc, index) { ids[index] = 'id' + index; return ids; }, { }) };
        }
      };
      const docs = [{ identifier: 'invalid', created_at: '2019-05-11T07:40:00.000Z' }];
      let written;
      await (async function ( ) {
        const warn = console.warn;
        console.warn = function ( ) { };
        try {
          written = await writeIntent.forCollection(storage, 'devicestatus', 'v1/internal', { env: { } })
            .write({ op: 'create', docs: docs });
        } finally {
          console.warn = warn;
        }
      })();
      assert.equal(calls.some(function (c) { return /identifier/.test(String(c[1])); }), false);
      assert.equal(written.items[0].outcome, 'inserted');
      assert.equal(Object.prototype.hasOwnProperty.call(docs[0], 'identifier'), false);
    });
  });
});
