'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');

var offset = times.mins(2.5).msecs;
var bucketFields = ['index', 'fromMills', 'toMills'];

function init (ctx) {

  var translate = ctx.language.translate;
  var utils = require('../utils')(ctx);

  var bgnow = {
    name: 'bgnow'
    , label: 'BG Now'
    , pluginType: 'pill-primary'
  };

  bgnow.mostRecentBucket = function mostRecentBucket (buckets) {
    return _.find(buckets, function notEmpty(bucket) {
      return bucket && !bucket.isEmpty;
    });
  };

  bgnow.previousBucket = function previousBucket(recent, buckets) {
    var previous = null;

    if (_.isObject(recent)) {
      previous = _.chain(buckets).find(function afterFirstNotEmpty(bucket) {
        return bucket.mills < recent.mills && !bucket.isEmpty;
      }).value();
    }

    return previous;
  };

  bgnow.setProperties = function setProperties (sbx) {
    var buckets = bgnow.fillBuckets(sbx);
    var recent = bgnow.mostRecentBucket(buckets);
    var previous = bgnow.previousBucket(recent, buckets);
    var delta = bgnow.calcDelta(recent, previous, sbx);

    sbx.offerProperty('bgnow', function setBGNow ( ) {
      return _.omit(recent, bucketFields);
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

    var buckets = _.times(bucketCount, function createBucket (index) {
      var fromMills = lastSGVMills - offset - (index * bucketMsecs);
      return {
        index: index
        , fromMills: fromMills
        , toMills: fromMills + bucketMsecs
        , sgvs: [ ]
      };
    });

    _.takeRightWhile(sbx.data.sgvs, function addToBucket (sgv) {

      //if in the future, return true and keep taking right
      if (sgv.mills > sbx.time) {
        return true;
      }

      var bucket = _.find(buckets, function containsSGV (bucket) {
        return sgv.mills >= bucket.fromMills && sgv.mills <= bucket.toMills;
      });

      if (bucket) {
        bucket.sgvs.push(sgv);
      }

      return bucket;
    });

    return _.map(buckets, bgnow.analyzeBucket);
  };

  function notError (entry) {
    return entry && entry.mgdl > 39; //TODO maybe lower instead of expecting dexcom?
  }

  function isError (entry) {
    return !entry || !entry.mgdl || entry.mgdl < 39;
  }

  bgnow.analyzeBucket = function analyzeBucket (bucket) {

    if (_.isEmpty(bucket.sgvs)) {
      bucket.isEmpty = true;
      return bucket;
    }

    var details = { };

    var sgvs = _.filter(bucket.sgvs, notError);

    function calcMean ( ) {
      var sum = 0;
      _.forEach(sgvs, function eachSGV (sgv) {
        sum += Number(sgv.mgdl);
      });

      return sum / sgvs.length;
    }

    var mean = calcMean(sgvs);

    if (mean && _.isNumber(mean)) {
      details.mean = mean;
    }

    var mostRecent = _.maxBy(sgvs, 'mills');

    if (mostRecent) {
      details.last = mostRecent.mgdl;
      details.mills = mostRecent.mills;
    }

    var errors = _.filter(bucket.sgvs, isError);
    if (!_.isEmpty(errors)) {
      details.errors = errors;
    }

    return _.merge(details, bucket);
  };

  bgnow.calcDelta = function calcDelta (recent, previous, sbx) {

    if (_.isEmpty(recent)) {
      //console.info('No recent CGM data is available');
      return null;
    }

    if (_.isEmpty(previous)) {
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

    delta.mgdl = Math.round(recent.mean - delta.mean5MinsAgo);

    delta.scaled = sbx.settings.units === 'mmol' ?
      sbx.roundBGToDisplayFormat(sbx.scaleMgdl(recent.mean) - sbx.scaleMgdl(delta.mean5MinsAgo)) : delta.mgdl;

    delta.display = (delta.scaled >= 0 ? '+' : '') + delta.scaled;

    delta.previous = _.omit(previous, bucketFields);

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
      _.forEach(prop.sgvs, function deviceAndValue(entry) {
        var device = utils.deviceName(entry.device);
        deviceInfos[device] = {
          time: utils.timeFormat(moment(entry.mills), sbx)
          , value: sbx.scaleEntry(entry)
          , recent: entry
        };
      });
    }

    if (delta && delta.previous && delta.previous.sgvs) {
      _.forEach(delta.previous.sgvs, function deviceAndValue(entry) {
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

      if (_.keys(deviceInfos).length > 1) {
        _.forIn(deviceInfos, function addInfo(deviceInfo, name) {
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
      , info: _.isEmpty(info) ? null : info
    });
  };

  return bgnow;

}

module.exports = init;
