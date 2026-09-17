
'use strict';

var should = require('should');


describe('ddata', function ( ) {
  // var sandbox = require('../lib/sandbox')();
  // var env = require('../lib/server/env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();

  it('should be a module', function (done) {
    var libddata = require('../lib/data/ddata');
    var ddata = libddata( );
    should.exist(ddata);
    should.exist(libddata);
    should.exist(libddata.call);
    ddata = ctx.ddata.clone( );
    should.exist(ddata);
    done( );
  });

  it('has #clone( )', function (done) {
    should.exist(ctx.ddata.treatments);
    should.exist(ctx.ddata.sgvs);
    should.exist(ctx.ddata.mbgs);
    should.exist(ctx.ddata.cals);
    should.exist(ctx.ddata.profiles);
    should.exist(ctx.ddata.devicestatus);
    should.exist(ctx.ddata.lastUpdated);
    var ddata = ctx.ddata.clone( );
    should.exist(ddata);
    should.exist(ddata.treatments);
    should.exist(ddata.sgvs);
    should.exist(ddata.mbgs);
    should.exist(ddata.cals);
    should.exist(ddata.profiles);
    should.exist(ddata.devicestatus);
    should.exist(ddata.lastUpdated);
    done( );
  });

  it('processRawDataForRuntime derives duration and endmills from durationInMilliseconds', function () {
    var ddata = require('../lib/data/ddata')();
    var createdAt = '2026-03-06T10:00:00.000Z';
    var result = ddata.processRawDataForRuntime([{
      _id: '507f1f77bcf86cd799439011',
      created_at: createdAt,
      durationInMilliseconds: 26584
    }])[0];

    result.mills.should.equal(new Date(createdAt).getTime());
    result.duration.should.equal(0);
    result.endmills.should.equal(result.mills + 26584);
  });

  it('idMergePreferNew matches records by identifier when _id is missing', function () {
    var ddata = require('../lib/data/ddata')();
    var merged = ddata.idMergePreferNew(
      [{ _id: 'mongo-id', identifier: 'loop-id', carbs: 15 }],
      [{ identifier: 'loop-id', carbs: 0 }]
    );

    merged.length.should.equal(1);
    merged[0].carbs.should.equal(0);
    merged[0].identifier.should.equal('loop-id');
  });

  // TODO: ensure partition function gets called via:
  // Properties
  // * ddata.devicestatus
  // * ddata.mbgs
  // * ddata.sgvs
  // * ddata.treatments
  // * ddata.profiles
  // * ddata.lastUpdated
  // Methods
  // * ddata.processTreatments
  // * ddata.processDurations
  // * ddata.clone
  // * ddata.split
 

});
