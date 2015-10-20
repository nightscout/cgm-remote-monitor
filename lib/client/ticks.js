'use strict';

function prepare (client, scaleY) {

  scaleY = scaleY || client.settings.scaleY;

  if (scaleY === 'linear') {
    return prepareLinear();
  } else {
    return prepareLog();
  }

  function prepareLog() {
    if (client.settings.units === 'mmol') {
      return [
        2.0
        , Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgLow))
        , Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgTargetBottom))
        , 6.0
        , Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgTargetTop))
        , Math.round(client.utils.scaleMgdl(client.settings.thresholds.bgHigh))
        , 22.0
      ];
    } else {
      return [
        40
        , client.settings.thresholds.bgLow
        , client.settings.thresholds.bgTargetBottom
        , 120
        , client.settings.thresholds.bgTargetTop
        , client.settings.thresholds.bgHigh
        , 400
      ];
    }
  }

  function prepareLinear() {
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
}

module.exports = prepare;