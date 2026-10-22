'use strict';

// Small "last 7 days Time in Range" widget rendered into #tirWidget on the
// main monitor view. No-ops gracefully when the container div is absent
// (retro-mode / frame views).

var SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
var REFRESH_INTERVAL_MS = 15 * 60 * 1000;
var MMOL_FACTOR = 18.018;

var BAND_COLORS = ['#b71c1c', '#ff5959', '#4caf50', '#ffe358', '#ffb74d'];

function init (client, $) {

  var widget = {};
  var container = $('#tirWidget');

  // Views without the widget div (retro-mode, frames) get a no-op API
  if (!container.length) {
    widget.load = function load () { };
    widget.refresh = function refresh () { };
    return widget;
  }

  var started = false;
  var refreshTimer = null;
  var failureLogged = false;

  function usesMmol () {
    return client.settings && client.settings.units === 'mmol';
  }

  function displayThreshold (mgdl) {
    if (usesMmol()) {
      return (mgdl / MMOL_FACTOR).toFixed(1);
    }
    return '' + mgdl;
  }

  function computeStats (entries) {
    var bands = [0, 0, 0, 0, 0]
      , tight = 0
      , total = 0;

    entries.forEach(function eachEntry (entry) {
      var sgv = entry && Number(entry.sgv);
      if (!sgv || isNaN(sgv) || sgv <= 39 || sgv >= 1000) {
        return;
      }
      total += 1;
      if (sgv < 54) {
        bands[0] += 1;
      } else if (sgv < 70) {
        bands[1] += 1;
      } else if (sgv <= 180) {
        bands[2] += 1;
      } else if (sgv <= 250) {
        bands[3] += 1;
      } else {
        bands[4] += 1;
      }
      if (sgv >= 70 && sgv <= 140) {
        tight += 1;
      }
    });

    return {
      total: total
      , bandPcts: bands.map(function toPct (count) {
        return total ? (count / total) * 100 : 0;
      })
      , tir: total ? (bands[2] / total) * 100 : null
      , titr: total ? (tight / total) * 100 : null
    };
  }

  function headlineColor (tir) {
    if (tir >= 70) {
      return '#4caf50';
    } else if (tir >= 50) {
      return '#ffe358';
    }
    return '#ff5959';
  }

  function buildTooltip (stats) {
    var pct1 = function pct1 (value) { return value.toFixed(1) + '%'; };
    var lines = [
      client.translate('Time in Range') + ' (7d)'
      , '<' + displayThreshold(54) + ': ' + pct1(stats.bandPcts[0])
      , displayThreshold(54) + '-' + displayThreshold(69) + ': ' + pct1(stats.bandPcts[1])
      , displayThreshold(70) + '-' + displayThreshold(180) + ': ' + pct1(stats.bandPcts[2])
      , displayThreshold(181) + '-' + displayThreshold(250) + ': ' + pct1(stats.bandPcts[3])
      , '>' + displayThreshold(250) + ': ' + pct1(stats.bandPcts[4])
      , 'TITR ' + displayThreshold(70) + '-' + displayThreshold(140) + ': ' + pct1(stats.titr)
      , stats.total + ' ' + client.translate('readings')
    ];
    return lines.join('\n');
  }

  function render (stats) {
    var label = $('<div class="tir-label"></div>');
    label.append($('<span class="tir-name"></span>').text(client.translate('TIR') + ' 7d'));

    container.empty();

    if (!stats.total) {
      // No data available - avoid showing NaN
      label.append($('<span class="tir-headline"></span>').text('—'));
      container.append(label);
      container.attr('title', client.translate('Time in Range') + ' (7d): ' + client.translate('No data available'));
      container.removeClass('hidden');
      return;
    }

    label.append(
      $('<span class="tir-headline"></span>')
        .text(Math.round(stats.tir) + '%')
        .css('color', headlineColor(stats.tir))
    );

    var bar = $('<div class="tir-bar"></div>');
    stats.bandPcts.forEach(function eachBand (pct, index) {
      bar.append(
        $('<div class="tir-band"></div>')
          .css('width', pct + '%')
          .css('background-color', BAND_COLORS[index])
      );
    });

    var titr = $('<div class="tir-titr"></div>').text('TITR ' + Math.round(stats.titr) + '%');

    container.append(label).append(bar).append(titr);
    container.attr('title', buildTooltip(stats));
    container.removeClass('hidden');
  }

  widget.refresh = function refresh () {
    var since = Date.now() - SEVEN_DAYS_MS;
    $.ajax({
      method: 'GET'
      , url: '/api/v1/entries/sgv.json?find[date][$gte]=' + since + '&count=10000'
      , headers: client.headers()
    }).done(function success (entries) {
      failureLogged = false;
      render(computeStats(entries || []));
    }).fail(function fail () {
      // e.g. 401 on token-restricted views - hide and retry on the next cycle.
      // Log only the first failure so an expected, persistent condition (no
      // read access) doesn't spam the console every 15 minutes.
      if (!failureLogged) {
        console.info('TIR widget: could not load entries; hiding until data is available');
        failureLogged = true;
      }
      container.addClass('hidden');
    });
  };

  widget.load = function load () {
    if (started) {
      return;
    }
    started = true;
    widget.refresh();
    refreshTimer = window.setInterval(widget.refresh, REFRESH_INTERVAL_MS);
  };

  widget.stop = function stop () {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    started = false;
  };

  return widget;
}

module.exports = init;
