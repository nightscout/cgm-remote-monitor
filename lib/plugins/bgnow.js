'use strict';

var _ = require('lodash');
var times = require('../times');
var units = require('../units')();

function init() {

  var bgnow = {
    name: 'bgnow'
    , label: 'BG Now'
    , pluginType: 'pill-primary'
  };

  bgnow.setProperties = function setProperties (sbx) {
    sbx.offerProperty('bgnow', function setBGNow ( ) {
      var buckets = bgnow.fillBuckets(sbx);

      var property = {
        buckets: buckets
      };

      var delta = bgnow.calcDelta(buckets, sbx);
      if (!_.isEmpty(delta)) {
        property.delta = delta;
      }

      return property;
    });
  };

  bgnow.fillBuckets = function fillBuckets (sbx, opts) {

    var bucketCount = (opts && opts.bucketCount) || 4;
    var bucketMins = (opts && opts.bucketMins) || 5;
    var bucketMsecs = times.mins(bucketMins).msecs;

    var lastSGVMills = sbx.lastSGVMills();

    var buckets = _.times(bucketCount, function createBucket (index) {
      var fromMills = lastSGVMills - (index * bucketMsecs);
      return {
        index: index
        , fromMills: fromMills
        , toMills: fromMills + bucketMsecs
        , sgvs: [ ]
      }
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

    _.forEach(buckets, bgnow.analyzeBucket);

//    _.forEach(buckets, function log (bucket) {
//      console.info('>>>bucket', bucket);
//    });

    return buckets;
  };

  function notError (entry) {
    return entry.mgdl > 39; //TODO maybe lower instead of expecting dexcom?
  }

  function isError (entry) {
    return entry.mgdl < 39;
  }

  bgnow.analyzeBucket = function analyzeBucket (bucket) {

    if (_.isEmpty(bucket.sgvs)) {
      bucket.isEmpty = true
      return;
    }

    var details = { };

    var mean = _.chain(bucket.sgvs)
      .filter(notError)
      .meanBy('mgdl')
      .value();

    if (_.isNumber(mean)) {
      details.mean = mean;
    }

    var mostRecent = _.chain(bucket.sgvs)
      .filter(notError)
      .maxBy('mills')
      .value();

    var mills = mostRecent && mostRecent.mills;

    if (_.isNumber(mills)) {
      details.mills = mills;
    }

    var errors = _.filter(bucket.sgvs, isError);

    if (!_.isEmpty(errors)) {
      details.errors = errors;
    }

    _.merge(bucket, details);
  };

  bgnow.calcDelta = function calcDelta (buckets, sbx) {

    var first = _.first(buckets);

    if (_.isEmpty(first) || first.isEmpty) {
      return null;
    }

    var next = _.chain(buckets).drop(1).find(function notEmpty (bucket) {
      return !bucket.isEmpty;
    }).value();

    if (_.isEmpty(next)) {
      return null;
    }

    var delta = {
      absolute: first.mean - next.mean
      , elapsedMins: (first.mills - next.mills) / times.min().msecs
    };

    delta.interpolated = delta.elapsedMins > 9;

    delta.mean5MinsAgo = delta.interpolated ?
      first.mean - delta.absolute / delta.elapsedMins * 5 : first.mean - delta.absolute;

    delta.mgdl = Math.round(first.mean - delta.mean5MinsAgo);

    delta.scaled = sbx.settings.units === 'mmol' ?
      sbx.roundBGToDisplayFormat(sbx.scaleMgdl(first.mean) - sbx.scaleMgdl(delta.mean5MinsAgo)) : delta.mgdl;

    delta.display = (delta.scaled >= 0 ? '+' : '') + delta.scaled;

    return delta;

  };

  bgnow.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.bgnow && sbx.properties.bgnow.delta;

    var info = [];
    var display = prop && prop.display;

    if (prop && prop.interpolated) {
      display += ' *';
      info.push({label: 'Elapsed Time', value: Math.round(prop.elapsedMins) + ' mins'});
      info.push({label: 'Absolute Delta', value: sbx.roundBGToDisplayFormat(sbx.scaleMgdl(prop.absolute)) + ' ' + sbx.unitsLabel});
      info.push({label: 'Interpolated', value: sbx.roundBGToDisplayFormat(sbx.scaleMgdl(prop.mean5MinsAgo)) + ' ' + sbx.unitsLabel});
    }

    sbx.pluginBase.updatePillText({
      name: 'delta'
      , label: 'BG Delta'
      , pluginType: 'pill-major'
      , pillFlip: true
    }, {
      value: display
      , label: sbx.unitsLabel
      , info: info
    });
  };


  return bgnow;

}

module.exports = init;
