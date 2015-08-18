'use strict';

var _ = require('lodash');

var sandbox = require('./sandbox')();
var units = require('./units')();
var iob = require('./plugins/iob')();
var delta = require('./plugins/delta')();

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


function prepareSGVs (req, sbx) {
  var bgs = [];
  var data = sbx.data;

  function scaleMgdlAPebbleLegacyHackThatWillNotGoAway (bg) {
    if (req.mmol) {
      return units.mgdlToMMOL(bg);
    } else {
      return bg.toString();
    }
  }

  //for compatibility we're keeping battery and iob here, but they would be better somewhere else
  if (data.sgvs.length > 0) {
    var cal = sbx.lastEntry(sbx.data.cals);

    bgs = _.map(reverseAndSlice(data.sgvs, req), function transformSGV (sgv) {
      var transformed = {
        sgv: scaleMgdlAPebbleLegacyHackThatWillNotGoAway(sgv.mgdl)
        , trend: directionToTrend(sgv.direction)
        , direction: sgv.direction
        , datetime: sgv.mills
      };

      if (req.rawbg && cal) {
        transformed.filtered = sgv.filtered;
        transformed.unfiltered = sgv.unfiltered;
        transformed.noise = sgv.noise;
      }

      return transformed;
    });

    var prev = data.sgvs.length >= 2 ? data.sgvs[data.sgvs.length - 2] : null;
    var current = sbx.lastSGVEntry();

    //for legacy reasons we need to return a 0 for delta if it can't be calculated
    var deltaResult = delta.calc(prev, current, sbx);
    bgs[0].bgdelta = deltaResult && deltaResult.scaled || 0;
    if (req.mmol) {
      bgs[0].bgdelta = bgs[0].bgdelta.toFixed(1);
    }

    bgs[0].battery = data.devicestatus && data.devicestatus.uploaderBattery && data.devicestatus.uploaderBattery.toString();
    if (req.iob) {
      var iobResult = iob.calcTotal(data.treatments, data.profile, Date.now());
      if (iobResult) {
        bgs[0].iob = iobResult.display;
      }
    }
  }

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
  return sandbox.serverInit(clonedEnv, req.ctx);
}

function pebble (req, res) {
  var sbx = prepareSandbox(req);

  res.setHeader('content-type', 'application/json');
  res.write(JSON.stringify({
    status: [ {now: Date.now()} ]
    , bgs: prepareSGVs(req, sbx)
    , cals: prepareCals(req, sbx)
  }));

  res.end( );
}

function configure (env, ctx) {
  function middle (req, res, next) {
    req.env = env;
    req.ctx = ctx;
    req.rawbg = env.settings.isEnabled('rawbg');
    req.iob = env.settings.isEnabled('iob');
    req.mmol = (req.query.units || env.DISPLAY_UNITS) === 'mmol';
    req.count = parseInt(req.query.count) || 1;

    next( );
  }
  return [middle, pebble];
}

configure.pebble = pebble;

module.exports = configure;
