'use strict';

function prepare (client, opts) {
  opts = checkOptions(client, opts);

  if (opts.scaleY === 'linear') {
    return prepareLinear(client, opts);
  } else {
    return prepareLog(client, opts);
  }
}

function checkOptions (client, opts) {
  opts = opts || {};
  opts.scaleY = opts.scaleY || client.settings.scaleY;
  //assume any values from opts are already scaled
  //do any other scaling here
  opts.high = opts.high || Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgHigh));
  opts.targetTop = opts.targetTop || Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgTargetTop));
  opts.targetBottom = opts.targetBottom || Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgTargetBottom));
  opts.low = opts.low || Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgLow));

  return opts;
}

function prepareLog (client, opts) {
  if (client.settings.units === 'mmol') {
    return [
      2.0
      , Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgLow))
      , opts.targetBottom
      , 6.0
      , opts.targetTop
      , opts.high
      , 22.0
    ];
  } else {
    return [
      40
      , opts.low
      , opts.targetBottom
      , 120
      , opts.targetTop
      , opts.high
      , 400
    ];
  }
}

function prepareLinear (client, opts) {
  if (client.settings.units === 'mmol') {
    return [
      2.0
      , 4.0
      , 6.0
      , 8.0
      , 10.0
      , 12.0
      , 14.0
      , 16.0
      , 18.0
      , 20.0
      , 22.0
    ];
  } else {
    return [
      40
      , 80
      , 120
      , 160
      , 200
      , 240
      , 280
      , 320
      , 360
      , 400
    ];
  }
}

module.exports = prepare;