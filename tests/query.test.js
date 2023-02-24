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
}); 
