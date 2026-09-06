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
}); 
