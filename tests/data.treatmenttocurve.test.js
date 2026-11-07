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

  // A treatment's units may be spelled 'mmol/L' or 'mmol/l' as well as 'mmol'; each is
  // read as mmol/L, as the profile and the tooltip read it (BF-157)
  it('reads a treatment glucose in mmol/L in any spelling of its units', function() {
    var ddata = require('../lib/data/ddata')();
    ddata.sgvs = [{mgdl: 90, mills: before},{mgdl: 100, mills: now}];
    ddata.treatments = [
      {_id: 'mmol_1', mills: before, glucose: 7, units: 'mmol/L'}
      , {_id: 'mmol_2', mills: before, glucose: 7, units: 'mmol/l'}
      , {_id: 'mmol_3', mills: before, glucose: 7, units: 'mmol'}
      , {_id: 'mgdl_1', mills: before, glucose: 126, units: 'mg/dL'}
      , {_id: 'mgdl_2', mills: before, glucose: 126, units: 'mg/dl'}
    ];
    fitTreatmentsToBGCurve(ddata, {
        settings: settings
      }
      , {
        language: require('../lib/language')()
      }
    );
    ddata.treatments.slice(0, 3).forEach(function (t) {
      t.should.have.property('mmol', 7);
      t.should.not.have.property('mgdl');
    });
    ddata.treatments.slice(3).forEach(function (t) {
      t.should.have.property('mgdl', 126);
      t.should.not.have.property('mmol');
    });
  });

});