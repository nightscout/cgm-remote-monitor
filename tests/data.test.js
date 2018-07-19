'use strict';

require('should');

describe('Data', function ( ) {

  var env = require('../env')();
  var ctx = {};
  var data = require('../lib/data')(env, ctx);

  var now = Date.now();
  var before = now - (5 * 60 * 1000);


  it('should return original data if there are no changes', function() {
    data.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var delta = data.calculateDeltaBetweenDatasets(data,data);    
    delta.should.equal(data);
  });

  it('adding one sgv record should return delta with one sgv', function() {
    data.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var newData = data.clone();
    newData.sgvs = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var delta = data.calculateDeltaBetweenDatasets(data,newData);    
    delta.delta.should.equal(true);
    delta.sgvs.length.should.equal(1);
  });

  it('adding one treatment record should return delta with one treatment', function() {
    data.treatments = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var newData = data.clone();
    newData.treatments = [{mgdl: 100, mills: before},{mgdl: 100, mills: now},{mgdl: 100, mills:98}];
    var delta = data.calculateDeltaBetweenDatasets(data,newData);
    delta.delta.should.equal(true);
    delta.treatments.length.should.equal(1);
  });

  it('changes to treatments, mbgs and cals should be calculated even if sgvs is not changed', function() {
    data.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    data.treatments = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    data.mbgs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    data.cals = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var newData = data.clone();
    newData.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.treatments = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.mbgs = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.cals = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    var delta = data.calculateDeltaBetweenDatasets(data,newData);
    delta.delta.should.equal(true);
    delta.treatments.length.should.equal(1);
    delta.mbgs.length.should.equal(1);
    delta.cals.length.should.equal(1);
  });

  it('delta should include profile and devicestatus object if changed', function() {
    data.sgvs = [{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    data.profiles = {foo:true};
    data.devicestatus = {foo:true};
    var newData = data.clone();
    newData.sgvs = [{mgdl: 100, mills:101},{mgdl: 100, mills: before},{mgdl: 100, mills: now}];
    newData.profiles = {bar:true};
    newData.devicestatus = {bar:true};
    var delta = data.calculateDeltaBetweenDatasets(data,newData);
    delta.profiles.bar.should.equal(true);
    delta.devicestatus.bar.should.equal(true);
  });

  it('update treatment display BGs', function() {
    data.sgvs = [{mgdl: 90, mills: before},{mgdl: 100, mills: now}];
    data.treatments = [
      {mills: before, glucose: 100, units: 'mgdl'} //with glucose and units
      , {mills: before, glucose: 5.5, units: 'mmol'} //with glucose and units
      , {mills: now - 120000, insulin: '1.00'} //without glucose, between sgvs
      , {mills: now + 60000, insulin: '1.00'} //without glucose, after sgvs
      , {mills: before - 120000, insulin: '1.00'} //without glucose, before sgvs
    ];
    data.updateTreatmentDisplayBGs();
    data.treatments[0].mgdl.should.equal(100);
    data.treatments[1].mmol.should.equal(5.5);
    data.treatments[2].mgdl.should.equal(95);
    data.treatments[3].mgdl.should.equal(100);
    data.treatments[4].mgdl.should.equal(90);
  });

});