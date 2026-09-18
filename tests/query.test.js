'use strict';

require('should');

var moment = require('moment');

describe('query', function ( ) {
  var query = require('../lib/server/query');

  it('should provide default options', function ( ) {
    var opts = query();

    var low = moment().utc().subtract(4, 'days').subtract(1, 'minutes').format();
    var high = moment().utc().subtract(4, 'days').add(1, 'minutes').format();

    opts.date['$gte'].should.be.greaterThan(low);
    opts.date['$gte'].should.be.lessThan(high);
  });

  it('should not override non default options', function ( ) {
    var opts = query({}, {
      deltaAgo: 2 * 24 * 60 * 60000,
      dateField: 'created_at'
    });

    var low = moment().utc().subtract(2, 'days').subtract(1, 'minutes').format();
    var high = moment().utc().subtract(2, 'days').add(1, 'minutes').format();

    opts.created_at['$gte'].should.greaterThan(low);
    opts.created_at['$gte'].should.lessThan(high);
  });

  it('should not enforce date filter if query includes id', function ( ) {
    var opts = query({ find: { _id: 1234 } });

    (typeof opts.date).should.equal('undefined')
  });

  it('should keep non-ObjectId _id queries as strings', function ( ) {
    var uuid = '69F15FD2-8075-4DEB-AEA3-4352F455840D';
    var opts = query({ find: { _id: uuid } });

    opts._id.should.equal(uuid);
  });

  it('should convert ObjectId-shaped _id queries', function ( ) {
    var objectId = '55cbd4e47e726599048a3f91';
    var opts = query({ find: { _id: objectId } });

    opts._id.toString().should.equal(objectId);
  });
  describe('date filter normalization', function () {
    const cases = [
      ['2026-09-05 00:00:00-04:00', '2026-09-05T04:00:00.000Z'],
      ['2026-09-05 00Z', '2026-09-05T00:00:00.000Z'],
      ['2026-09-05 00:00:00Z', '2026-09-05T00:00:00.000Z'],
      ['2026-09-05 00:00:00+02:00', '2026-09-04T22:00:00.000Z'],
      ['2026-09-05T00:00:00+02:00', '2026-09-04T22:00:00.000Z'],
      ['2026-09-05T00:00:00 02:00', '2026-09-04T22:00:00.000Z'],
      ['2026-09-05 00:00:00 02:00', '2026-09-04T22:00:00.000Z'],
      ['2026-09-05T00:00:00 0230', '2026-09-04T21:30:00.000Z'],
      ['2026-09-05 00:00:00.123 02', '2026-09-04T22:00:00.123Z']
    ];

    cases.forEach(function (testCase) {
      it('normalizes ' + testCase[0], function () {
        const result = query({ find: { created_at: { $gte: testCase[0] } } }, {
          dateField: 'created_at', walker: {}
        });
        result.created_at.$gte.should.equal(testCase[1]);
      });
    });

    it('still rejects invalid dates', function () {
      (() => query({ find: { created_at: { $gte: '2026-99-05T00:00:00Z' } } }, {
        dateField: 'created_at', walker: {}
      })).should.throw(/Cannot parse/);
    });
  });

  describe('schema-driven type coercion', function () {
    const fs = require('fs');
    const path = require('path');
    const qs = require('qs');
    const coercion = require('../lib/server/query-coercion');

    // Collections whose storage module asks query.js to type fields from the
    // schema. Each must still do so, and each must still be in the table.
    const WIRED = ['entries', 'treatments', 'devicestatus', 'profile', 'activity'];

    function find (collection, queryString, extra) {
      return query(qs.parse(queryString), Object.assign({ collection: collection }, extra || { }));
    }

    function treatments (queryString) {
      return find('treatments', queryString, { dateField: 'created_at' });
    }

    it('keeps a fractional bound on a number field instead of truncating it', function () {
      treatments('find[insulin][$gte]=1.5').insulin.$gte.should.equal(1.5);
      treatments('find[carbs][$gte]=7.5').carbs.$gte.should.equal(7.5);
      treatments('find[glucose][$lte]=99.5').glucose.$lte.should.equal(99.5);
    });

    it('converts a bound on an integer field without truncating it either', function () {
      // The value is a bound, not a stored value: `>= 1.5` on an integer field
      // means 2 and above, which truncating to 1 gets wrong.
      find('entries', 'find[noise][$gte]=1.5', { useEpoch: true }).noise.$gte.should.equal(1.5);
    });

    it('converts numeric filters that used to stay strings', function () {
      find('entries', 'find[delta][$gte]=1.5', { useEpoch: true }).delta.$gte.should.equal(1.5);
      treatments('find[duration][$gte]=30').duration.$gte.should.equal(30);
      treatments('find[rate][$gte]=0.5').rate.$gte.should.equal(0.5);
      const battery = find('devicestatus', 'find[uploader.battery][$lt]=50',
        { dateField: 'created_at' });
      battery['uploader.battery'].$lt.should.equal(50);
      const bolus = find('profile', 'find[loopSettings.maximumBolus][$gte]=2.5',
        { dateField: 'startDate' });
      bolus['loopSettings.maximumBolus'].$gte.should.equal(2.5);
    });

    it('converts booleans', function () {
      find('entries', 'find[isValid]=false', { useEpoch: true }).isValid.should.equal(false);
      find('entries', 'find[isValid]=TRUE', { useEpoch: true }).isValid.should.equal(true);
    });

    it('leaves a boolean spelled some other way alone', function () {
      find('entries', 'find[isValid]=yes', { useEpoch: true }).isValid.should.equal('yes');
    });

    it('converts every element of an $in list', function () {
      find('entries', 'find[sgv][$in][]=120&find[sgv][$in][]=140', { useEpoch: true })
        .sgv.$in.should.eql([120, 140]);
    });

    it('leaves operands that are not field values alone', function () {
      // `{$exists: 'true'}` is a yes/no question and `^3` is a pattern, not
      // readings. Converting either yields NaN, which $regex rejects outright
      // and MongoDB reads as true -- wrong to produce, either way.
      //
      // The $exists assertion is deliberately "was not turned into a number"
      // rather than "is still the string". BF-40 reads that operand as a
      // boolean, in a later pass and on every field whether or not the schema
      // types it. Pinning the exact string here would fail the day that lands,
      // over a difference this test is not about -- and this test IS about not
      // running a numeric conversion over an operand.
      const exists = find('devicestatus', 'find[uploader.battery][$exists]=true',
        { dateField: 'created_at' });
      (typeof exists['uploader.battery'].$exists === 'number').should.equal(false);
      treatments('find[duration][$regex]=^3').duration.$regex.should.equal('^3');
    });

    // The one non-value operand that DOES have a type. Leaving it as text
    // would have been a regression: origin/dev coerced it along with
    // everything else, so `$type=2` reached the server as the number 2 and
    // worked. As the string "2" it is rejected -- "Unknown type name alias: 2"
    // -- turning a working request into an HTTP 500. Measured on mongod 3.6.8
    // and 7.0.43.
    it('reads a $type operand as a BSON code, and leaves aliases alone', function () {
      find('entries', 'find[sgv][$type]=2', { useEpoch: true })
        .sgv.$type.should.equal(2);
      find('entries', 'find[sgv][$type]=number', { useEpoch: true })
        .sgv.$type.should.equal('number');
    });

    it('leaves fields the schema does not declare as strings', function () {
      treatments('find[madeUpField][$gte]=5').madeUpField.$gte.should.equal('5');
    });

    it('lets an explicit walker entry win over the schema', function () {
      // treatments turns `notes` into a regular expression: a search
      // affordance, not a claim about the field's type. The schema calls
      // `notes` a string, and must not take the entry back.
      const opts = query(qs.parse('find[notes]=/abc/i'), {
        collection: 'treatments'
        , dateField: 'created_at'
        , walker: { notes: query.parseRegEx }
      });
      opts.notes.should.be.instanceof(RegExp);
      opts.notes.source.should.equal('abc');
      opts.notes.flags.should.equal('i');
    });

    it('does not change behaviour when no collection is named', function () {
      // Callers that pass no collection keep the old assumption that `date`
      // and `sgv` are int-typed, and nothing else is converted.
      const opts = query(qs.parse('find[sgv][$gte]=120.5&find[delta][$gte]=1.5'), { });
      opts.sgv.$gte.should.equal(120);
      opts.delta.$gte.should.equal('1.5');
    });

    describe('the table and the code that uses it', function () {
      it('has an entry for every collection wired to it', function () {
        WIRED.forEach(function (collection) {
          coercion.knows(collection).should.equal(true, collection + ' is missing from the table');
        });
      });

      it('is still asked for by every wired storage module', function () {
        WIRED.forEach(function (collection) {
          const source = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'server', collection + '.js'), 'utf8');
          source.should.match(new RegExp("collection: '" + collection + "'"),
            collection + '.js no longer names its collection');
        });
      });

      it('declares only types the query layer acts on', function () {
        const kinds = new Set();
        Object.keys(coercion.table.collections).forEach(function (collection) {
          const fields = coercion.table.collections[collection];
          Object.keys(fields).forEach(function (field) { kinds.add(fields[field]); });
        });
        Array.from(kinds).sort().should.eql(['boolean', 'integer', 'number']);
      });
    });
  });
});
