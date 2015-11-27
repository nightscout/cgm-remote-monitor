'use strict';

var _ = require('lodash');
var moment = require('moment');

var timeago = require('./timeago')();

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

      var loopStatus = checkLoopStatus(openapsStatus, sbx);
      openapsStatus = openapsStatus || {};
      openapsStatus.status = loopStatus;

      return openapsStatus;
    });
  };

  openaps.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.openaps;

    var info = [];

    function valueString (prefix, value) {
      return value ? prefix + value : '';
    }

    if ('enacted' === prop.status.code) {
      info.push({label: 'Status', value: 'enacted' + valueString(', reason: ', prop.openaps && prop.openaps.enacted && prop.openaps.enacted.reason)});
    } else if ('looping' === prop.status.code) {
      info.push({label: 'Status', value: 'looping' + valueString(', suggested: ', prop.openaps && prop.openaps.suggested && prop.openaps.suggested.reason)});
    } else if ('waiting' === prop.status.code) {
      info.push({label: 'Status', value: 'waiting'});
    }

    var recent = moment(sbx.time).subtract(15, 'minutes');

    if (prop.pump && prop.pump.clock) {
      var pumpTime = moment(prop.pump.clock);
      if (pumpTime.isAfter(recent)) {
        info.push({label: 'Pump Clock', value: pumpTime.format('LT')});
      }
    }

    if ('enacted' === prop.status.code && prop.openaps && prop.openaps.enacted) {
      var enactedTime = moment(prop.openaps.enacted.timestamp);
      if (prop.openaps.enacted.rate === 0 && prop.openaps.enacted.duration === 0) {
        info.push({label: 'Temp Basal Canceled', value: timeAt(false, sbx) + timeFormat(enactedTime, sbx)});
      } else {
        info.push({
          label: 'Temp Basal Started'
          , value: prop.openaps.enacted.rate.toFixed(3) +
            ' for ' + prop.openaps.enacted.duration +
            'm' + timeAt(true, sbx) + timeFormat(enactedTime, sbx)});
      }
    }

    if (prop.openaps && prop.openaps.iob) {
      var iobTime = moment(prop.openaps.iob.timestamp);
      if (iobTime.isAfter(recent)) {
        info.push({label: 'IOB', value: sbx.roundInsulinForDisplayFormat(prop.openaps.iob.iob) + 'U' + timeAt(true, sbx) + timeFormat(iobTime, sbx)});
        info.push({label: 'Bolus IOB', value: sbx.roundInsulinForDisplayFormat(prop.openaps.iob.bolusiob) + 'U'});
        info.push({label: 'Insulin Activity', value: prop.openaps.iob.activity.toFixed(2) + ' ' + sbx.unitsLabel + '/5m'});
      }
    }

    sbx.pluginBase.updatePillText(openaps, {
      value: timeFormat(prop.status.when, sbx)
      , label: 'OpenAPS ' + prop.status.symbol
      , info: info
    });
  };

  return openaps;

}

function checkLoopStatus (openapsStatus, sbx)  {

  var status = {
    symbol: '⚠'
    , code: 'warning'
  };

  var enactedLast = openapsStatus && openapsStatus.openaps.enacted && moment(openapsStatus.openaps.enacted.timestamp);
  var suggestedLast = openapsStatus && openapsStatus.openaps.suggested && moment(openapsStatus.openaps.suggested.timestamp);

  var last = openapsStatus && moment(openapsStatus.mills);
  var recent = moment(sbx.time).subtract(15, 'minutes');

  var enactedEnd = enactedLast && enactedLast.add(openapsStatus.openaps.enacted.duration, 'minutes');

  if ((!suggestedLast || enactedLast.isAfter(suggestedLast)) && ((enactedEnd && enactedEnd.isAfter(recent)) || (enactedLast && enactedLast.isAfter(recent)))) {
    status.symbol = '⌁';
    status.code = 'enacted';
  } else if (suggestedLast && suggestedLast.isAfter(recent)) {
    status.symbol = '↻';
    status.code = 'looping';
  } else if (last && last.isAfter(recent)) {
    status.symbol = '◉';
    status.code = 'waiting';
  } else if (last) {
    status.symbol = '⚠';
    status.code = 'warning';
  }

  if (last) {
    status.when = last;
  }

  return status;
}

function timeFormat (m, sbx) {

  var when;
  if (m && sbx.data.inRetroMode) {
    when = m.format('LT');
  } else if (m) {
    var ago = timeago.calcDisplay({mills: m.valueOf()}, sbx.time);
    when = (ago.value ? ago.value : '') + ago.shortLabel + (ago.shortLabel.length === 1 ? ' ago' : '')
  } else {
    when = 'unknown';
  }

  return when
}

function timeAt (prefix, sbx) {
  return sbx.data.inRetroMode ? (prefix ? ' ' : '') + '@ ' : (prefix ? ', ' : '');
}

module.exports = init;