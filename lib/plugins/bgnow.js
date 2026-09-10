'use strict';

var times = require('../times');

var offset = times.mins(2.5).msecs;

function init (ctx) {

  var moment = ctx.moment;
  var translate = ctx.language.translate;
  var utils = require('../utils')(ctx);

  var bgnow = {
    name: 'bgnow'
    , label: 'BG Now'
    , pluginType: 'pill-primary'
  };
  bgnow.mostRecentBucket = function mostRecentBucket (buckets) {
    return buckets.find(function notEmpty(bucket) {
      return bucket && !bucket.isEmpty;
    });
  };
  bgnow.previousBucket = function previousBucket(recent, buckets) {
    var previous = null;

    if (recent && typeof recent === 'object') {
      previous = buckets.find(function afterFirstNotEmpty(bucket) {
        return bucket.mills < recent.mills && !bucket.isEmpty;
      });
    }

    return previous;
  };

  bgnow.setProperties = function setProperties (sbx) {
    var buckets = bgnow.fillBuckets(sbx);
    var recent = bgnow.mostRecentBucket(buckets);
    var previous = bgnow.previousBucket(recent, buckets);
    var delta = bgnow.calcDelta(recent, previous, sbx);
    sbx.offerProperty('bgnow', function setBGNow ( ) {
      const newBgNow = { ...recent };
        for (const key of ['index', 'fromMills', 'toMills']) {
          delete newBgNow[key];
        }
        return newBgNow;
    });

    sbx.offerProperty('delta', function setBGNow ( ) {
      return delta;
    });

    sbx.offerProperty('buckets', function setBGNow ( ) {
      return buckets;
    });
  };

  bgnow.fillBuckets = function fillBuckets (sbx, opts) {

    var bucketCount = (opts && opts.bucketCount) || 4;
    var bucketMins = (opts && opts.bucketMins) || 5;
    var bucketMsecs = times.mins(bucketMins).msecs;

    var lastSGVMills = sbx.lastSGVMills();

    var buckets = Array.from({ length: bucketCount }, function createBucket(_, index) {
      var fromMills = lastSGVMills - offset - (index * bucketMsecs);
      return {
        index: index,
        fromMills: fromMills,
        toMills: fromMills + bucketMsecs,
        sgvs: []
      };
    });

    sbx.data.sgvs.filter((sgv) => {

      //if in the future, return true and keep taking right
      if (sgv.mills > sbx.time) {
        return true;
      }      var bucket = buckets.find(function containsSGV (bucket) {
        return sgv.mills >= bucket.fromMills && sgv.mills <= bucket.toMills;
      });

      if (bucket) {
        sbx.scaleEntry(sgv);
        bucket.sgvs.push(sgv);
      }

      return bucket;
    });

    return buckets.map(bgnow.analyzeBucket);
  };

  function notError (entry) {
    return entry && entry.mgdl > 39; //TODO maybe lower instead of expecting dexcom?
  }

  function isError (entry) {
    return !entry || !entry.mgdl || entry.mgdl < 39;
  }

  bgnow.analyzeBucket = function analyzeBucket (bucket) {

    if (utils.isEmpty(bucket.sgvs)) {
      bucket.isEmpty = true;
      return bucket;
    }
    var details = { };

    var sgvs = bucket.sgvs.filter(notError);
    function calcMean ( ) {
      var sum = 0;
      sgvs.forEach(function eachSGV (sgv) {
        sum += Number(sgv.mgdl);
      });

      return sum / sgvs.length;
    }

    var mean = calcMean(sgvs);

    if (mean !== null && mean !== undefined && typeof mean === 'number' && !isNaN(mean)) {
      details.mean = mean;
    }
    var mostRecent = sgvs.length > 0
      ? sgvs.reduce((max, sgv) => (!max || (sgv?.mills || 0) > (max?.mills || 0) ? sgv : max), null)
      : null;

    if (mostRecent) {
      details.last = mostRecent.mgdl;
      details.mills = mostRecent.mills;
    }
    var errors = bucket.sgvs.filter(isError);
    if (errors.length > 0) {
      details.errors = errors;
    }

    return Object.assign({}, details, bucket);
  };

  bgnow.calcDelta = function calcDelta (recent, previous, sbx) {

    if (utils.isEmpty(recent)) {
      //console.info('No recent CGM data is available');
      return null;
    }

    if (utils.isEmpty(previous)) {
      //console.info('previous bucket not found, not calculating delta');
      return null;
    }

    var delta = {
      absolute: recent.mean - previous.mean
      , elapsedMins: (recent.mills - previous.mills) / times.min().msecs
    };

    delta.interpolated = delta.elapsedMins > 9;

    delta.mean5MinsAgo = delta.interpolated ?
      recent.mean - delta.absolute / delta.elapsedMins * 5 : recent.mean - delta.absolute;

    delta.times = {
      recent: recent.mills
      , previous: previous.mills
    };

    delta.mgdl = Math.round(recent.mean - delta.mean5MinsAgo);

    delta.scaled = sbx.settings.units === 'mmol' ?
      sbx.roundBGToDisplayFormat(sbx.scaleMgdl(recent.mean) - sbx.scaleMgdl(delta.mean5MinsAgo)) : delta.mgdl;
    delta.display = (delta.scaled >= 0 ? '+' : '') + delta.scaled;


    // eslint-disable-next-line no-unused-vars
    const { index, fromMills, toMills, ...previousRest } = previous;
    delta.previous = previousRest;

    return delta;

  };

  bgnow.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.bgnow;
    var delta = sbx.properties.delta;

    var info = [];
    var display = delta && delta.display;

    if (delta && delta.interpolated) {
      display += ' *';
      info.push({label: translate('Elapsed Time'), value: Math.round(delta.elapsedMins) + ' ' + translate('mins')});
      info.push({label: translate('Absolute Delta'), value: sbx.roundBGToDisplayFormat(sbx.scaleMgdl(delta.absolute)) + ' ' + sbx.unitsLabel});
      info.push({label: translate('Interpolated'), value: sbx.roundBGToDisplayFormat(sbx.scaleMgdl(delta.mean5MinsAgo)) + ' ' + sbx.unitsLabel});
    }

    var deviceInfos = { };
    if (prop.sgvs) {
      prop.sgvs.forEach(function deviceAndValue(entry) {
        var device = utils.deviceName(entry.device);
        deviceInfos[device] = {
          time: utils.timeFormat(moment(entry.mills), sbx)
          , value: sbx.scaleEntry(entry)
          , recent: entry
        };
      });
    }    if (delta && delta.previous && delta.previous.sgvs) {
      delta.previous.sgvs.forEach(function deviceAndValue(entry) {
        var device = utils.deviceName(entry.device);
        var deviceInfo = deviceInfos[device];
        if (deviceInfo && deviceInfo.recent) {
          var deviceDelta = bgnow.calcDelta(
            { mills: deviceInfo.recent.mills , mean: deviceInfo.recent.mgdl}
            , { mills: entry.mills, mean: entry.mgdl}
            , sbx
          );

          if (deviceDelta) {
            deviceInfo.delta = deviceDelta.display
          }
        } else {
          deviceInfos[device] = {
            time: utils.timeFormat(moment(entry.mills), sbx)
            , value: sbx.scaleEntry(entry)
          };
        }
      });

      if (Object.keys(deviceInfos).length > 1) {
        Object.entries(deviceInfos).forEach(([name, deviceInfo]) => {
          var display = deviceInfo.value;
          if (deviceInfo.delta) {
            display += ' ' + deviceInfo.delta;
          }

          display += ' (' + deviceInfo.time + ')';

          info.push({label: name, value: display});
        });
      }
    }

    sbx.pluginBase.updatePillText({
      name: 'delta'
      , label: translate('BG Delta')
      , pluginType: 'pill-major'
      , pillFlip: true
    }, {
      value: display
      , label: sbx.unitsLabel
      , info: utils.isEmpty(info) ? null : info
    });
  };

  function virtAsstDelta(next, slots, sbx) {
    var delta = sbx.properties.delta;

    next(
      translate('virtAsstTitleDelta')
      , translate(delta.interpolated ? 'virtAsstDeltaEstimated' : 'virtAsstDelta'
      , {
          params: [
            delta.display == '+0' ? '0' : delta.display
            , moment(delta.times.recent).from(moment(sbx.time))
            , moment(delta.times.previous).from(moment(sbx.time))
          ]
        }
      )
    );
  }

  bgnow.virtAsst = {
    intentHandlers: [{
      intent: "MetricNow"
      , metrics: ["delta"]
      , intentHandler: virtAsstDelta
    }]
  };

  return bgnow;

}

module.exports = init;
