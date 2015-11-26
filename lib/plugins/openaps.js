'use strict';

var _ = require('lodash');
var moment = require('moment');

function init() {

  var openaps = {
    name: 'openaps'
    , label: 'OpenAPS'
    , pluginType: 'pill-status'
  };

  openaps.setProperties = function setProperties (sbx) {
    sbx.offerProperty('openaps', function setopenaps ( ) {
      var openapsStatus = _.findLast(sbx.data.devicestatus, function (status) {
        return sbx.entryMills(status) <= sbx.time && ('openaps' in status);
      });

      if (openapsStatus) {
        openapsStatus.status = checkLoopStatus(openapsStatus);
      }

      return openapsStatus;
    });
  };

  openaps.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.openaps;

    sbx.pluginBase.updatePillText(openaps, {
      value: prop ? prop.status : 'unknown'
      , label: 'OpenAPS'
      , info: [{label: 'TODO', value: JSON.stringify(prop)}]
    });
  };

  return openaps;

}

function checkLoopStatus (openapsStatus)  {

  var status = 'offline';

  var enactedLast = openapsStatus.openaps.enacted && moment(openapsStatus.openaps.enacted.timestamp);
  var suggestedLast = openapsStatus.openaps.suggested && moment(openapsStatus.openaps.suggested.timestamp);

  console.info('>>>enactedLast', enactedLast);
  console.info('>>>suggestedLast', suggestedLast);

  if (enactedLast && enactedLast.add(openapsStatus.openaps.enacted.duration, 'minutes').isBefore(moment())) {
    status = 'enacting';
  } else if (suggestedLast.isAfter(moment().subtract(15, 'minutes'))) {
    status = 'looping';
  }

  return status;
}

module.exports = init;