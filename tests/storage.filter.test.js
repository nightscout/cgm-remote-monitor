'use strict';

require('should');

const filter = require('../lib/storage/filter');
const { validate, toMongo, fromMongo, and, or, cmp } = filter;
const queryCreate = require('../lib/server/query');
const fallbackKey = require('../lib/server/treatment-fallback-key');
const softDeleted = require('../lib/server/soft-deleted');
const { parseFilter } = require('../lib/api3/storage/mongoCollection/utils');

describe('storage filter AST', function ( ) {

  describe('validation is the operator allowlist', function ( ) {

    it('accepts every declared operator', function ( ) {
      for (const op of filter.CMP) {
        const value = op === 'in' || op === 'nin' ? [1]
          : op === 're' ? 'x'
          : op === 'exists' ? true
          : op === 'nottype' ? 'array'
          : op === 'type' ? 'string'
          : 1;
        validate({ op, field: 'a', value }).should.be.an.Object();
      }
    });

    it('rejects operators that are not declared', function ( ) {
      // The point of the AST: an unlisted operator cannot be represented, so it
      // cannot reach a backend.
      for (const op of ['where', 'expr', 'regex', 'text', 'near', 'jsonSchema', 'nor', 'elemMatch']) {
        (() => validate({ op, field: 'a', value: 1 })).should.throw(/unsupported operator/);
      }
    });

    it('rejects a field path that is not a plain dotted identifier', function ( ) {
      for (const field of ['a b', 'a;b', "a'b", 'a$b', '$where', '', '1a', 'a..b', 'a.', 'a.0']) {
        (() => validate({ op: 'eq', field, value: 1 })).should.throw();
      }
    });

    it('accepts nested dotted paths', function ( ) {
      validate({ op: 'lt', field: 'uploader.battery', value: 50 }).should.be.an.Object();
    });

    it('requires an array for in/nin and a string for re', function ( ) {
      (() => validate({ op: 'in', field: 'a', value: 1 })).should.throw(/requires an array/);
      (() => validate({ op: 're', field: 'a', value: 7 })).should.throw(/requires a string/);
    });

    it('bounds regex pattern length', function ( ) {
      // The ReDoS mitigation: unbounded patterns reach the engine today.
      const long = 'a'.repeat(filter.RE_MAX_LEN + 1);
      (() => validate({ op: 're', field: 'a', value: long })).should.throw(/exceeds/);
      validate({ op: 're', field: 'a', value: 'a'.repeat(filter.RE_MAX_LEN) }).should.be.an.Object();
    });

    it('accepts only the regex flags MongoDB honours', function ( ) {
      validate(cmp('re', 'a', 'x', 'i')).should.be.an.Object();
      validate(cmp('re', 'a', 'x', 'imsx')).should.be.an.Object();
      for (const bad of ['g', 'y', 'u', 'z', 'iv']) {
        (() => validate(cmp('re', 'a', 'x', bad))).should.throw(/unsupported regex flag/);
      }
      (() => validate(cmp('re', 'a', 'x', 7))).should.throw(/options must be a string/);
    });

    it('takes a single BSON type name for type, and only array for nottype', function ( ) {
      validate(cmp('type', 'a', 2)).should.be.an.Object();
      validate(cmp('type', 'a', 'string')).should.be.an.Object();
      (() => validate(cmp('type', 'a', ['array', 'decimal']))).should.throw(/type requires a type name/);
      (() => validate(cmp('nottype', 'a', 'string'))).should.throw(/supports only 'array'/);
      (() => validate(cmp('exists', 'a', 'true'))).should.throw(/exists requires a boolean/);
    });

    it('refuses an empty or, which would otherwise match everything', function ( ) {
      // An empty disjunction is FALSE. Emitted as {} it would be TRUE -- every
      // document -- and MongoDB itself refuses `$or: []`.
      (() => validate(or())).should.throw(/or requires at least one node/);
      (() => toMongo(and(cmp('eq', 'a', 1), or()))).should.throw(/or requires at least one node/);
      // An empty conjunction is TRUE, which is what "unfiltered" means.
      validate(and()).should.be.an.Object();
    });

    it('validates recursively through groups', function ( ) {
      (() => validate(and(cmp('eq', 'a', 1), { op: 'where', field: 'b', value: 2 })))
        .should.throw(/unsupported operator/);
    });
  });

  describe('MongoDB adapter', function ( ) {

    it('maps each of v3\'s operators exactly as api3 parseFilter does', function ( ) {
      // Compared against parseFilter itself rather than a transcription, so a
      // change to either side shows up here. parseFilter splits in/nin values
      // on '|' into strings; the AST takes the array that split produces.
      const v3 = (operator, value) => parseFilter([{ field: 'a', operator, value }], 'and');
      for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']) {
        toMongo(cmp(op, 'a', 7)).should.eql(v3(op, 7));
      }
      toMongo(cmp('in', 'a', ['1', '2'])).should.eql(v3('in', '1|2'));
      toMongo(cmp('nin', 'a', ['1', '2'])).should.eql(v3('nin', '1|2'));
      toMongo(cmp('re', 'a', '^x')).should.eql(v3('re', '^x'));
    });

    it('maps the v1 extensions', function ( ) {
      toMongo(cmp('exists', 'a', true)).should.eql({ a: { $exists: true } });
      toMongo(cmp('type', 'a', 2)).should.eql({ a: { $type: 2 } });
      toMongo(cmp('nottype', 'a', 'array')).should.eql({ a: { $not: { $type: 'array' } } });
    });

    it('carries regex flags as $options', function ( ) {
      toMongo(cmp('re', 'a', 'x', 'i')).should.eql({ a: { $regex: 'x', $options: 'i' } });
      // No flags means no $options key at all, so the emitted filter is
      // byte-identical to what the codebase produces today.
      toMongo(cmp('re', 'a', 'x')).should.eql({ a: { $regex: 'x' } });
    });

    it('passes values through untouched, so MongoDB\'s type brackets apply', function ( ) {
      // The adapter never coerces: "120" stays a string, null stays null, an
      // empty list stays empty. tests/api3.storage.filter-semantics.test.js
      // pins what mongod then does with each of them.
      toMongo(cmp('gte', 'sgv', '120')).should.eql({ sgv: { $gte: '120' } });
      toMongo(cmp('lte', 'sgv', null)).should.eql({ sgv: { $lte: null } });
      toMongo(cmp('nin', 'sgv', [])).should.eql({ sgv: { $nin: [] } });
      toMongo(cmp('in', 'noise', [1, 'a', null])).should.eql({ noise: { $in: [1, 'a', null] } });
    });

    it('builds and/or groups', function ( ) {
      // `and` of comparisons on non-colliding field/operator pairs emits
      // MongoDB's compact conjunction, which is what the codebase already
      // produces and what the planner sees today.
      toMongo(and(cmp('gte', 'sgv', 100), cmp('lt', 'sgv', 200)))
        .should.eql({ sgv: { $gte: 100, $lt: 200 } });
      toMongo(and(cmp('eq', 'type', 'sgv'), cmp('gte', 'date', 1)))
        .should.eql({ type: { $eq: 'sgv' }, date: { $gte: 1 } });
      toMongo(or(cmp('lt', 'sgv', 70), cmp('gt', 'sgv', 180)))
        .should.eql({ $or: [{ sgv: { $lt: 70 } }, { sgv: { $gt: 180 } }] });
    });

    it('nests groups', function ( ) {
      // A nested group cannot be merged, so this falls back to explicit $and.
      toMongo(and(cmp('eq', 'type', 'sgv'), or(cmp('lt', 'sgv', 70), cmp('gt', 'sgv', 180))))
        .should.eql({ $and: [
          { type: { $eq: 'sgv' } },
          { $or: [{ sgv: { $lt: 70 } }, { sgv: { $gt: 180 } }] }
        ] });
    });

    it('falls back to $and when the same field and operator collide', function ( ) {
      // {a: {$eq: 1}, a: {$eq: 2}} is not expressible as one object.
      toMongo(and(cmp('eq', 'a', 1), cmp('eq', 'a', 2)))
        .should.eql({ $and: [{ a: { $eq: 1 } }, { a: { $eq: 2 } }] });
      toMongo(and(cmp('re', 'a', 'x', 'i'), cmp('re', 'a', 'y')))
        .should.eql({ $and: [{ a: { $regex: 'x', $options: 'i' } }, { a: { $regex: 'y' } }] });
    });

    it('treats an empty and as unfiltered', function ( ) {
      toMongo(and()).should.eql({ });
    });
  });

  describe('fromMongo — the API v1 migration bridge', function ( ) {

    // The v1 modules will convert lib/server/query.js's OUTPUT rather than
    // reimplementing its logic in AST terms, so what has to hold is that the
    // round trip selects the same documents. fromMongo reshapes deliberately
    // (implicit equality becomes $eq), so these assert the resulting Mongo
    // filter, not structural identity. The result-set proof is the
    // differential in the alignment repository's tools/seam.

    function roundTrip (mongoFilter) {
      return toMongo(fromMongo(mongoFilter));
    }

    function fieldsNamed (f, out = new Set()) {
      for (const [k, v] of Object.entries(f)) {
        if (k === '$and' || k === '$or') v.forEach(branch => fieldsNamed(branch, out));
        else out.add(k);
      }
      return [...out].sort();
    }

    it('round-trips the shapes lib/server/query.js actually emits', function ( ) {
      roundTrip({ type: 'sgv' }).should.eql({ type: { $eq: 'sgv' } });
      roundTrip({ date: { $gte: 1789 } }).should.eql({ date: { $gte: 1789 } });
      // Round-trips to the identical compact form, not to an explicit $and.
      roundTrip({ sgv: { $gte: 100, $lte: 200 } }).should.eql({ sgv: { $gte: 100, $lte: 200 } });
      roundTrip({ created_at: { $eq: 'x' }, eventType: { $eq: 'Note' } })
        .should.eql({ created_at: { $eq: 'x' }, eventType: { $eq: 'Note' } });
      roundTrip({ $or: [{ sgv: { $lt: 70 } }, { sgv: { $gt: 180 } }] })
        .should.eql({ $or: [{ sgv: { $lt: 70 } }, { sgv: { $gt: 180 } }] });
      roundTrip({ 'uploader.battery': { $lt: 50 } })
        .should.eql({ 'uploader.battery': { $lt: 50 } });
      roundTrip({ carbs: { $ne: null } }).should.eql({ carbs: { $ne: null } });
      roundTrip({ insulin: { $exists: true } }).should.eql({ insulin: { $exists: true } });
      roundTrip({ eventType: { $regex: '^Temp' } }).should.eql({ eventType: { $regex: '^Temp' } });
      roundTrip({ sgv: { $type: 2 } }).should.eql({ sgv: { $type: 2 } });
    });

    it('round-trips live output from lib/server/query.js', function ( ) {
      // The real thing, not a transcription: build filters the way the entries
      // and treatments modules do and push them through the bridge.
      const entriesOpts = () => ({ walker: { date: parseInt, sgv: parseInt, mbg: parseInt }, useEpoch: true });
      const treatmentsOpts = () => ({ walker: { insulin: parseInt, eventType: queryCreate.parseRegEx }
        , dateField: 'created_at' });

      const cases = [
        [{ count: 10 }, entriesOpts]
        , [{ find: { type: 'sgv' } }, entriesOpts]
        , [{ find: { sgv: { $gte: '100', $lte: '200' } } }, entriesOpts]
        , [{ find: { date: { $gte: '1700000000000' } } }, entriesOpts]
        , [{ find: { $or: [{ sgv: { $lt: '70' } }, { sgv: { $gt: '180' } }] } }, entriesOpts]
        , [{ find: { sgv: { $type: '2' } } }, entriesOpts]
        , [{ find: { mbg: { $exists: 'false' } } }, entriesOpts]
        , [{ find: { insulin: { $gte: '1' } } }, treatmentsOpts]
        , [{ find: { eventType: '/Bolus/i' } }, treatmentsOpts]
      ];

      for (const [params, optsFn] of cases) {
        const mongoFilter = queryCreate(params, optsFn());
        // Must not throw: every shape query.js produces is expressible.
        const ast = fromMongo(mongoFilter);
        validate(ast).should.be.an.Object();
        // Every field the filter names survives the round trip. (A field
        // beside an $or comes back inside an explicit $and, so this compares
        // the fields named at any depth rather than the top-level keys.)
        fieldsNamed(toMongo(ast)).should.eql(fieldsNamed(mongoFilter));
      }
    });

    it('round-trips the treatment fallback key and the soft-delete wrapper unchanged', function ( ) {
      // BF-121's selector is {$in: [null, ''], $not: {$type: 'array'}} on each
      // client id: two nodes on one field, merged back into one object.
      const key = fallbackKey.fallbackQuery({ eventType: 'Note' }, '2026-01-01T00:00:00.000Z'
        , { withAmounts: true });
      roundTrip(key).should.eql(key);
      const wrapped = softDeleted.visible({ isValid: true, type: 'sgv' }, { });
      roundTrip(wrapped).should.eql({ $and: [{ isValid: { $eq: true }, type: { $eq: 'sgv' } }
        , { isValid: { $ne: false } }] });
    });

    it('reads $exists the way mongod does, not the way JavaScript does', function ( ) {
      // Measured on mongod 8.0.34 over a document with the field and one
      // without: false, 0, -0, null and undefined (sent by the driver as null)
      // ask for ABSENCE; '', NaN, 'false', [] and {} ask for PRESENCE.
      // Decision recorded: `$exists ''` follows MongoDB. lib/server/query.js
      // reads 'true'/'false'/'1'/'0' itself (#8737) and leaves '' alone, so ''
      // reaches here and must mean what mongod made of it.
      const exists = v => fromMongo({ a: { $exists: v } }).value;
      for (const v of [false, 0, -0, null, undefined]) exists(v).should.equal(false, String(v));
      for (const v of [true, 1, '', NaN, 'false', [], {}]) exists(v).should.equal(true, String(v));
    });

    it('keeps a native RegExp instead of silently dropping it', function ( ) {
      // Object.keys(/x/i) is [], so the generic object branch produced no
      // nodes and the clause vanished -- widening the query rather than
      // narrowing it. lib/server/query.js's parseRegEx returns a native RegExp
      // for the treatments notes/eventType/enteredBy filters, so this is a
      // production shape.
      fromMongo({ eventType: /Bolus/i })
        .should.eql({ op: 're', field: 'eventType', value: 'Bolus', options: 'i' });
      roundTrip({ eventType: /Bolus/i })
        .should.eql({ eventType: { $regex: 'Bolus', $options: 'i' } });
      roundTrip({ eventType: /Bolus/i, created_at: { $gte: 'x' } })
        .should.eql({ eventType: { $regex: 'Bolus', $options: 'i' }, created_at: { $gte: 'x' } });
    });

    it('carries a native RegExp\'s flags as the driver puts them on the wire', function ( ) {
      // js-bson writes i for ignoreCase, m for multiline and s for GLOBAL, and
      // drops JavaScript's own s/u/y/d. Measured on mongod 8.0.34 over
      // {'a\nb', 'axb'}: /a.b/g matches both, /a.b/s matches only 'axb'.
      // (The seam's version mapped /x/gi to 'i' and /x/s to 's' -- JavaScript's
      // meaning, not the wire's -- which the differential caught.)
      fromMongo({ a: /x/gi }).should.eql({ op: 're', field: 'a', value: 'x', options: 'is' });
      fromMongo({ a: /x/s }).should.eql({ op: 're', field: 'a', value: 'x' });
      fromMongo({ a: /x/muy }).should.eql({ op: 're', field: 'a', value: 'x', options: 'm' });
      fromMongo({ a: /x/ }).should.eql({ op: 're', field: 'a', value: 'x' });
    });

    it('accepts $regex with $options, in either spelling', function ( ) {
      fromMongo({ a: { $regex: 'x', $options: 'i' } })
        .should.eql({ op: 're', field: 'a', value: 'x', options: 'i' });
      // `u` is accepted by mongod and ignored (UTF mode is always on).
      fromMongo({ a: { $regex: 'x', $options: 'iu' } })
        .should.eql({ op: 're', field: 'a', value: 'x', options: 'i' });
      // A RegExp may also appear as the $regex value.
      fromMongo({ a: { $regex: /x/m } })
        .should.eql({ op: 're', field: 'a', value: 'x', options: 'm' });
      fromMongo({ a: { $regex: /x/, $options: 'i' } })
        .should.eql({ op: 're', field: 'a', value: 'x', options: 'i' });
    });

    it('refuses every regex shape mongod refuses, instead of answering it', function ( ) {
      // Each of these is an error from mongod 8.0.34. Translating any of them
      // into a valid query would turn a refused read into a result set.
      (() => fromMongo({ a: { $options: 'i' } })).should.throw(/\$options without \$regex/);
      (() => fromMongo({ a: { $regex: 123 } })).should.throw(/must be a string or a RegExp/);
      (() => fromMongo({ a: { $regex: 'x', $options: 1 } })).should.throw(/\$options .* must be a string/);
      for (const bad of ['g', 'y', 'd', 'v', 'l']) {
        (() => fromMongo({ a: { $regex: 'x', $options: bad } })).should.throw(/unsupported regex flag/);
      }
      (() => fromMongo({ a: { $regex: /x/i, $options: 'm' } })).should.throw(/both \$regex and \$options/);
    });

    it('applies the pattern length bound to a native RegExp too', function ( ) {
      const long = new RegExp('a'.repeat(filter.RE_MAX_LEN + 1), 'i');
      (() => validate(fromMongo({ a: long }))).should.throw(/exceeds/);
    });

    it('is an operator allowlist', function ( ) {
      (() => fromMongo({ $where: '1 == 1' })).should.throw(/unsupported top-level operator/);
      (() => fromMongo({ a: { $elemMatch: { b: 1 } } })).should.throw(/unsupported operator/);
      (() => fromMongo({ a: { $near: [1, 2] } })).should.throw(/unsupported operator/);
      (() => fromMongo({ $expr: { $gt: ['$a', '$b'] } })).should.throw(/unsupported top-level operator/);
      (() => fromMongo({ $nor: [{ a: 1 }] })).should.throw(/unsupported top-level operator/);
      (() => fromMongo({ a: { $not: { $type: 'string' } } })).should.throw(/unsupported operator '\$not'/);
    });

    it('refuses an empty $and or $or, as mongod does, instead of matching everything', function ( ) {
      // mongod: `$or argument must be a non-empty array`. An empty group here
      // became {} -- every document.
      (() => fromMongo({ $or: [] })).should.throw(/non-empty array/);
      (() => fromMongo({ $and: [] })).should.throw(/non-empty array/);
      (() => fromMongo({ a: 1, $or: [{ b: 1 }, { $and: [] }] })).should.throw(/non-empty array/);
    });

    it('treats a bare object value as a literal, not a nested query', function ( ) {
      // {a: {b: 1}} matches the subdocument; it is not an operator expression.
      roundTrip({ a: { b: 1 } }).should.eql({ a: { $eq: { b: 1 } } });
      // {a: {}} matches documents whose `a` is an empty object (mongod 8.0.34).
      // It has no keys at all, so it used to fall through to the operator map,
      // produce no node, and vanish -- every document.
      roundTrip({ a: { } }).should.eql({ a: { $eq: { } } });
      roundTrip({ a: { }, b: 1 }).should.eql({ a: { $eq: { } }, b: { $eq: 1 } });
    });

    it('treats an empty or absent filter as unfiltered', function ( ) {
      roundTrip({ }).should.eql({ });
      roundTrip(null).should.eql({ });
    });
  });
});
