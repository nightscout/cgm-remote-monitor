'use strict';

var _ = require('lodash');

var sandbox = require('./sandbox')();
var units = require('./units')();

var DIRECTIONS = {
  NONE: 0
  , DoubleUp: 1
  , SingleUp: 2
  , FortyFiveUp: 3
  , Flat: 4
  , FortyFiveDown: 5
  , SingleDown: 6
  , DoubleDown: 7
  , 'NOT COMPUTABLE': 8
  , 'RATE OUT OF RANGE': 9
};

function directionToTrend (direction) {
  var trend = 8;
  if (direction in DIRECTIONS) {
    trend = DIRECTIONS[direction];
  }
  return trend;
}

function reverseAndSlice (entries, req) {
  var reversed = entries.slice(0);
  reversed.reverse();
  return reversed.slice(0, req.count);
}


function mapSGVs(req, sbx) {
  function scaleMgdlAPebbleLegacyHackThatWillNotGoAway (bg) {
    if (req.mmol) {
      return units.mgdlToMMOL(bg);
    } else {
      return bg.toString();
    }
  }

  var cal = sbx.lastEntry(sbx.data.cals);

  return _.map(reverseAndSlice(sbx.data.sgvs, req), function transformSGV(sgv) {
    var transformed = {
      sgv: scaleMgdlAPebbleLegacyHackThatWillNotGoAway(sgv.mgdl), trend: directionToTrend(sgv.direction), direction: sgv.direction, datetime: sgv.mills
    };

    if (req.rawbg && cal) {
      transformed.filtered = sgv.filtered;
      transformed.unfiltered = sgv.unfiltered;
      transformed.noise = sgv.noise;
    }

    return transformed;
  });

}

function addExtraData (first, req, sbx) {
  //for compatibility we're keeping battery and iob on the first bg, but they would be better somewhere else

  var data = sbx.data;

  function addDelta() {
    var delta = sbx.properties.delta;

    //for legacy reasons we need to return a 0 for delta if it can't be calculated
    first.bgdelta = delta && delta.scaled || 0;
    if (req.mmol) {
      first.bgdelta = first.bgdelta.toFixed(1);
    }
  }

  function addBattery() {
    var uploaderStatus = _.findLast(data.devicestatus, function (status) {
      return ('uploader' in status);
    });

    var battery = uploaderStatus && uploaderStatus.uploader && uploaderStatus.uploader.battery;

    if (battery && battery >= 0) {
      first.battery = battery.toString();
    }
  }

  function addIOB() {
    if (req.iob) {
      var iobResult = req.ctx.plugins('iob').calcTotal(data.treatments, data.devicestatus, data.profile, Date.now());
      if (iobResult) {
        first.iob = iobResult.display || 0;
      }
      
      sbx.properties.iob = iobResult;
      var bwpResult = req.ctx.plugins('bwp').calc(sbx);

      if (bwpResult) {
        first.bwp = bwpResult.bolusEstimateDisplay;
        first.bwpo = bwpResult.outcomeDisplay;
      }
      
    }
  }

  function addCOB() {
    if (req.cob) {
      var cobResult = req.ctx.plugins('cob').cobTotal(data.treatments, data.devicestatus, data.profile, Date.now());
      if (cobResult) {
        first.cob = cobResult.display || 0;
      }
    }
  }

  addDelta();
  addBattery();
  addIOB();
  addCOB();
}

function prepareBGs (req, sbx) {
  if (sbx.data.sgvs.length === 0) {
    return [];
  }

  var bgs = mapSGVs(req, sbx);
  addExtraData(bgs[0], req, sbx);

  return bgs;
}

function prepareCals (req, sbx) {
  var data = sbx.data;

  if (req.rawbg && data.cals && data.cals.length > 0) {
    return _.map(reverseAndSlice(data.cals, req), function transformCal (cal) {
      return _.pick(cal, ['slope', 'intercept', 'scale']);
    });
  } else {
    return [];
  }
}

function prepareSandbox (req) {
  var clonedEnv = _.cloneDeep(req.env);
  if (req.mmol) {
    clonedEnv.settings.units = 'mmol';
  }

  var sbx = sandbox.serverInit(clonedEnv, req.ctx);
  req.ctx.plugins('bgnow').setProperties(sbx);

  return sbx;
}

function pebble (req, res) {
  var sbx = prepareSandbox(req);

  res.setHeader('content-type', 'application/json');
  res.write(JSON.stringify({
    status: [ {now: Date.now()} ]
    , bgs: prepareBGs(req, sbx)
    , cals: prepareCals(req, sbx)
  }));

  res.end( );
}

function configure (env, ctx) {
  var wares = require('./middleware/')(env);
  function middle (req, res, next) {
    req.env = env;
    req.ctx = ctx;
    req.rawbg = env.settings.isEnabled('rawbg');
    req.iob = env.settings.isEnabled('iob');
    req.cob = env.settings.isEnabled('cob');
    req.mmol = (req.query.units || env.DISPLAY_UNITS) === 'mmol';
    req.count = parseInt(req.query.count) || 1;

    next( );
  }
  return [middle, wares.sendJSONStatus, ctx.authorization.isPermitted('api:pebble,entries:read'), pebble];
}

configure.pebble = pebble;

module.exports = configure;
