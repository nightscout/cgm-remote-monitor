'use strict';


var sandbox = require('../sandbox');
var units = require('../units')();

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

  return reverseAndSlice(sbx.data.sgvs, req).map(function transformSGV(sgv) {
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

// bwpo is a glucose value (the expected outcome after the insulin on board), so it
// follows the requested units like sgv; bwp is in insulin units and is not converted
function outcomeInRequestedUnits (bwpResult, req, siteMmol) {
  if (req.mmol === siteMmol || bwpResult.errors) {
    return bwpResult.outcomeDisplay;
  }
  return req.mmol ? Number(units.mgdlToMMOL(bwpResult.outcome)) : units.mmolToMgdl(bwpResult.outcome);
}

function addExtraData (first, req, sbx, siteSbx) {
  //for compatibility we're keeping battery and iob on the first bg, but they would be better somewhere else

  var data = sbx.data;
  var siteData = siteSbx.data;

  function addDelta() {
    var delta = sbx.properties.delta;

    //for legacy reasons we need to return a 0 for delta if it can't be calculated
    //the delta follows the requested units, like the sgv: when mmol is requested the
    //sandbox is in mmol and delta.scaled is mmol; otherwise use the mg/dL delta, since
    //delta.scaled would be in mmol on a site whose display units are mmol
    if (req.mmol) {
      first.bgdelta = (delta && delta.scaled || 0).toFixed(1);
    } else {
      first.bgdelta = delta && delta.mgdl || 0;
    }
  }
  function addBattery() {
    var uploaderStatus = data.devicestatus.slice().reverse().find(function (status) {
      return ('uploader' in status);
    });

    var battery = uploaderStatus && uploaderStatus.uploader && uploaderStatus.uploader.battery;

    if (battery && battery >= 0) {
      first.battery = battery.toString();
    }
  }

  function addIOB() {
    if (req.iob) {
      var iobResult = req.ctx.plugins('iob').calcTotal(siteData.treatments, siteData.devicestatus, siteData.profile, Date.now());
      if (iobResult) {
        first.iob = iobResult.display || 0;
      }

      //the bolus estimate compares the reading with the profile's sensitivity and
      //targets, which are in the site's units, so it is computed in a sandbox in the
      //site's units whatever units the client asked for
      siteSbx.properties.iob = iobResult;
      var bwpResult = req.ctx.plugins('bwp').calc(siteSbx);

      if (bwpResult) {
        first.bwp = bwpResult.bolusEstimateDisplay;
        first.bwpo = outcomeInRequestedUnits(bwpResult, req, siteSbx.settings.units === 'mmol');
      }

    }
  }

  function addCOB() {
    if (req.cob) {
      var cobResult = req.ctx.plugins('cob').cobTotal(siteData.treatments, siteData.devicestatus, siteData.profile, Date.now());
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

function prepareBGs (req, sbx, siteSbx) {
  if (sbx.data.sgvs.length === 0) {
    return [];
  }

  var bgs = mapSGVs(req, sbx);
  addExtraData(bgs[0], req, sbx, siteSbx);

  return bgs;
}

function prepareCals (req, sbx) {
  var data = sbx.data;
  if (req.rawbg && data.cals && data.cals.length > 0) {
    return reverseAndSlice(data.cals, req).map(function transformCal (cal) {
      const { slope, intercept, scale } = cal;
      return { slope, intercept, scale };
    });
  } else {
    return [];
  }
}

// sandbox.scaleEntry stores the reading in the sandbox's units on the entry itself
// (entry.scaled) and reuses it afterwards. serverInit's data is a shallow clone, so
// its sgvs are the server's shared ctx.ddata.sgvs objects, which the alarm checks
// and /api/v2/properties also read. This sandbox may be in mmol on an mg/dL site,
// so it works on its own copies, without a scaled value stored by another sandbox.
function unscaledCopy (entry) {
  var copy = Object.assign({}, entry);
  delete copy.scaled;
  return copy;
}

function prepareSandbox (req, mmol) {
  // Deep clone environment to avoid modifying original request
  var clonedEnv = JSON.parse(JSON.stringify(req.env));
  if (mmol) {
    clonedEnv.settings.units = 'mmol';
  }

  var sbx = sandbox().serverInit(clonedEnv, req.ctx);
  sbx.data.sgvs = sbx.data.sgvs.map(unscaledCopy);
  req.ctx.plugins('bgnow').setProperties(sbx);

  return sbx;
}

function pebble (req, res) {
  //the readings and the delta are in the requested units: the sandbox is forced to
  //mmol when mmol is asked for and otherwise left in the site's units
  var sbx = prepareSandbox(req, req.mmol);
  //the bolus estimate, iob and cob use a sandbox in the site's units; it is the same
  //sandbox unless mmol was asked for on a site whose units are mg/dL
  var sameUnits = sbx.settings.units === req.env.settings.units;
  var siteSbx = sameUnits || !(req.iob || req.cob) ? sbx : prepareSandbox(req, false);

  res.setHeader('content-type', 'application/json');
  res.write(JSON.stringify({
    status: [ {now: Date.now()} ]
    , bgs: prepareBGs(req, sbx, siteSbx)
    , cals: prepareCals(req, sbx)
  }));

  res.end( );
}

function configure (env, ctx) {
  var wares = require('../middleware/')(env);
  function middle (req, res, next) {
    req.env = env;
    req.ctx = ctx;
    req.rawbg = env.settings.isEnabled('rawbg');
    req.iob = env.settings.isEnabled('iob');
    req.cob = env.settings.isEnabled('cob');
    req.mmol = (req.query.units || env.settings.units) === 'mmol';
    req.count = parseInt(req.query.count) || 1;

    next( );
  }
  return [middle, wares.sendJSONStatus, ctx.authorization.isPermitted('api:pebble,entries:read'), pebble];
}

configure.pebble = pebble;

module.exports = configure;
