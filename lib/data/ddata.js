'use strict';

var _ = require('lodash');
var ObjectID = require('mongodb').ObjectID;

function init( ) {

  var ddata = {
    sgvs: []
    , treatments: []
    , mbgs: []
    , cals: []
    , profiles: []
    , devicestatus: []
    , lastUpdated: 0
  };

  ddata.clone = function clone() {
    return _.cloneDeep(ddata, function (value) {
      //special handling of mongo ObjectID's
      //see https://github.com/lodash/lodash/issues/602#issuecomment-47414964
      if (value instanceof ObjectID) {
        return value.toString();
      }
    });
  };

  return ddata;

}

module.exports = init;