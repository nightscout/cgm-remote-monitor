'use strict';

require('should');

describe('Data', function ( ) {

  var env = require('../env')();
  var ctx = {};
  var data = require('../lib/data')(env, ctx);

  var now = Date.now();
  var before = now - (5 * 60 * 1000);


  it('should return original data if there are no changes', function() {
    data.sgvs = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    var delta = data.calculateDeltaBetweenDatasets(data,data);    
    delta.should.equal(data);
  });

  it('adding one sgv record should return delta with one sgv', function() {
    data.sgvs = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    var newData = data.clone();
    newData.sgvs = [{sgv: 100, mills:101},{sgv: 100, mills: before},{sgv: 100, mills: now}];
    var delta = data.calculateDeltaBetweenDatasets(data,newData);    
    delta.delta.should.equal(true);
    delta.sgvs.length.should.equal(1);
  });

  it('adding one treatment record should return delta with one treatment', function() {
    data.treatments = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    var newData = data.clone();
    newData.treatments = [{sgv: 100, mills: before},{sgv: 100, mills: now},{sgv: 100, mills:98}];
    var delta = data.calculateDeltaBetweenDatasets(data,newData);
    delta.delta.should.equal(true);
    delta.treatments.length.should.equal(1);
  });

  it('changes to treatments, mbgs and cals should be calculated even if sgvs is not changed', function() {
    data.sgvs = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    data.treatments = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    data.mbgs = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    data.cals = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    var newData = data.clone();
    newData.sgvs = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    newData.treatments = [{sgv: 100, mills:101},{sgv: 100, mills: before},{sgv: 100, mills: now}];
    newData.mbgs = [{sgv: 100, mills:101},{sgv: 100, mills: before},{sgv: 100, mills: now}];
    newData.cals = [{sgv: 100, mills:101},{sgv: 100, mills: before},{sgv: 100, mills: now}];
    var delta = data.calculateDeltaBetweenDatasets(data,newData);
    delta.delta.should.equal(true);
    delta.treatments.length.should.equal(1);
    delta.mbgs.length.should.equal(1);
    delta.cals.length.should.equal(1);
  });

  it('delta should include profile and devicestatus object if changed', function() {
    data.sgvs = [{sgv: 100, mills: before},{sgv: 100, mills: now}];
    data.profiles = {foo:true};
    data.devicestatus = {foo:true};
    var newData = data.clone();
    newData.sgvs = [{sgv: 100, mills:101},{sgv: 100, mills: before},{sgv: 100, mills: now}];
    newData.profiles = {bar:true};
    newData.devicestatus = {bar:true};
    var delta = data.calculateDeltaBetweenDatasets(data,newData);
    delta.profiles.bar.should.equal(true);
    delta.devicestatus.bar.should.equal(true);
  });

});