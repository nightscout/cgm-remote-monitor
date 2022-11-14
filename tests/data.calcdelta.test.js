'use strict';

require('should');

var calcDelta = require('../lib/data/calcdelta');

describe('Data', function ( ) {

  var now = Date.now();
  var before = now - (5 * 60 * 1000);

  it('should return original data if there are no changes', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var delta = calcDelta(ddata,ddata);
    delta.should.equal(ddata);
  });

  it('adding one sgv record should return delta with one sgv', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var newData = ddata.clone();
    newData.sgvs = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var delta = calcDelta(ddata,newData);
    delta.delta.should.equal(true);
    delta.sgvs.length.should.equal(1);
  });

  it('should update sgv if changed', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var newData = ddata.clone();
    newData.sgvs = [{mgdl: 110, mills: before},{mgdl: 100, mills: now}];
    var delta = calcDelta(ddata,newData);
    delta.delta.should.equal(true);
    delta.sgvs.length.should.equal(1);
  });

  it('adding one treatment record should return delta with one treatment', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.treatments = [{_id: 'someid_1', mgdl: 100, mills: before},{_id: 'someid_2', mgdl: 100, mills: now}];
    var newData = ddata.clone();
    newData.treatments = [{_id: 'someid_1', mgdl: 100, mills: before},{_id: 'someid_2', mgdl: 100, mills: now},{_id: 'someid_3', mgdl: 100, mills:98}];
    var delta = calcDelta(ddata,newData);
    delta.delta.should.equal(true);
    delta.treatments.length.should.equal(1);
  });

  it('changes to treatments, mbgs and cals should be calculated even if sgvs is not changed', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    ddata.treatments = [{_id: 'someid_1', mgdl: 100, mills: before},{_id: 'someid_2', mgdl: 100, mills: now}];
    ddata.mbgs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    ddata.cals = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var newData = ddata.clone();
    newData.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.treatments = [{_id: 'someid_3', mgdl: 100, mills:101},{_id: 'someid_1', mgdl: 100, mills: before},{_id: 'someid_2', mgdl: 100, mills: now}];
    newData.mbgs = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.cals = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var delta = calcDelta(ddata,newData);
    delta.delta.should.equal(true);
    delta.treatments.length.should.equal(1);
    delta.mbgs.length.should.equal(1);
    delta.cals.length.should.equal(1);
  });

  it('delta should include profile', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    ddata.profiles = {foo:true};
    var newData = ddata.clone();
    newData.sgvs = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.profiles = {bar:true};
    var delta = calcDelta(ddata,newData);
    delta.profiles.bar.should.equal(true);
  });

});