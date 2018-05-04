'use strict';

require('should');

var fitTreatmentsToBGCurve = require('../lib/data/treatmenttocurve');

describe('Data', function ( ) {

  var now = Date.now();
  var before = now - (5 * 60 * 1000);
  var settings = require('../lib/settings')();

  it('update treatment display BGs', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 90, mills: before},{mgdl: 100, mills: now}];
    ddata.treatments = [
      {_id: 'someid_1', mills: before, glucose: 100, units: 'mgdl'} //with glucose and units
      , {_id: 'someid_2', mills: before, glucose: 5.5, units: 'mmol'} //with glucose and units
      , {_id: 'someid_3', mills: now - 120000, insulin: '1.00'} //without glucose, between sgvs
      , {_id: 'someid_4', mills: now + 60000, insulin: '1.00'} //without glucose, after sgvs
      , {_id: 'someid_5', mills: before - 120000, insulin: '1.00'} //without glucose, before sgvs
    ];
    fitTreatmentsToBGCurve(ddata, {
        settings: settings
      }
      , {
        language: require('../lib/language')()
      }
    );
    ddata.treatments[0].mgdl.should.equal(100);
    ddata.treatments[1].mmol.should.equal(5.5);
    ddata.treatments[2].mgdl.should.equal(95);
    ddata.treatments[3].mgdl.should.equal(100);
    ddata.treatments[4].mgdl.should.equal(90);
  });

});