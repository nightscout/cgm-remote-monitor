'use strict';

var _ = require('lodash');
var times = require('../times');

var offset = times.mins(2.5).msecs;

function init() {

  var bgnow = {
    name: 'bgnow'
    , label: 'BG Now'
    , pluginType: 'pill-primary'
  };

  bgnow.setProperties = function setProperties (sbx) {
    sbx.offerProperty('bgnow', function setBGNow ( ) {
      var buckets = bgnow.fillBuckets(sbx);
      var property = bgnow.analyzeBuckets(buckets, sbx);
      return property;
    });
  };

  bgnow.fillBuckets = function fillBuckets (sbx, opts) {

    var bucketCount = (opts && opts.bucketCount) || 4;
    var bucketMins = (opts && opts.bucketMins) || 5;
    var bucketMsecs = times.mins(bucketMins).msecs;

    var lastSGVMills = sbx.lastSGVMills();

    var buckets = _.times(bucketCount, function createBucket (index) {
      var fromMills = lastSGVMills + offset - (index * bucketMsecs);
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

    _.forEach(buckets, bgnow.analyzeBucket);

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
      bucket.isEmpty = true;
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

  bgnow.analyzeBuckets = function analyzeBuckets(buckets, sbx) {
    var property = { };

    var recent = _.find(buckets, function notEmpty(bucket) {
      return bucket && !bucket.isEmpty;
    });

    if (_.isObject(recent)) {
      property.recent = recent;

      var previous = _.chain(buckets).find(function afterFirstNotEmpty(bucket) {
        return bucket.mills < recent.mills && !bucket.isEmpty;
      }).value();

      if (_.isObject(previous)) {
        property.previous = previous;
      }
    }

    property.buckets = buckets;

    var delta = bgnow.calcDelta(property, sbx);
    if (!_.isEmpty(delta)) {
      property.delta = delta;
    }
    return property;
  };

  bgnow.calcDelta = function calcDelta (property, sbx) {


    if (_.isEmpty(property.recent)) {
      console.info('all buckets are empty', property.buckets);
      return null;
    }

    if (_.isEmpty(property.previous)) {
      console.info('previous bucket not found, not calculating delta', property.buckets);
      return null;
    }

    var delta = {
      absolute: property.recent.mean - property.previous.mean
      , elapsedMins: (property.recent.mills - property.previous.mills) / times.min().msecs
    };

    delta.interpolated = delta.elapsedMins > 9;

    delta.mean5MinsAgo = delta.interpolated ?
      property.recent.mean - delta.absolute / delta.elapsedMins * 5 : property.recent.mean - delta.absolute;

    delta.mgdl = Math.round(property.recent.mean - delta.mean5MinsAgo);

    delta.scaled = sbx.settings.units === 'mmol' ?
      sbx.roundBGToDisplayFormat(sbx.scaleMgdl(property.recent.mean) - sbx.scaleMgdl(delta.mean5MinsAgo)) : delta.mgdl;

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
