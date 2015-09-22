'use strict';

var percentile = {
  name: 'percentile'
  , label: 'Percentile Chart'
  , pluginType: 'report'
};

function init() {
  return percentile;
}

module.exports = init;

percentile.html = function html(client) {
  var translate = client.translate;
  var ret =
      '<h1>' + translate('Glucose Percentile report') + '</h1>'
    + '<div style="height:500px;">'
    + '  <div class="chart" id="percentile-chart"></div>'
    + '</div>'
    ;
  return ret;
};

percentile.css =
    '#percentile-chart {'
  + '  width: 100%;'
  + '  height: 100%;'
  + '}'
  ;

percentile.report = function report_percentile(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var ss = require('simple-statistics');

  var minutewindow = 30; //minute-window should be a divisor of 60 
  
  var data = datastorage.allstatsrecords;
  
  var bins = [];
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      var readings = data.filter(function(record) {
        var recdate = new Date(record.displayTime);
        return recdate.getHours() === hour && recdate.getMinutes() >= minute &&
          recdate.getMinutes() < minute + minutewindow;
      });
      readings = readings.map(function(record) {
        return record.sgv;
      });
      bins.push([date, readings]);
      //console.log(date +  " - " + readings.length);
      //readings.forEach(function(x){console.log(x)});
    }
  }
  var dat10 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.1)];
  });
  var dat25 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.25)];
  });
  var dat50 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.5)];
  });
  var dat75 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.75)];
  });
  var dat90 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.9)];
  });
  var high = options.targetHigh;
  var low = options.targetLow;
  //dat50.forEach(function(x){console.log(x[0] + " - " + x[1])});
  $.plot(
    '#percentile-chart', [{
      label: translate('Median'),
      data: dat50,
      id: 'c50',
      color: '#000000',
      points: {
        show: false
      },
      lines: {
        show: true,
        //fill: true
      }
    }, {
      label: '25%/75% '+translate('percentile'),
      data: dat25,
      id: 'c25',
      color: '#000055',
      points: {
        show: false
      },
      lines: {
        show: true,
        fill: true
      },
      fillBetween: 'c50'
    }, {
      data: dat75,
      id: 'c75',
      color: '#000055',
      points: {
        show: false
      },
      lines: {
        show: true,
        fill: true
      },
      fillBetween: 'c50'
    }, {
      label: '10%/90% '+translate('percentile'),
      data: dat10,
      id: 'c10',
      color: '#a0a0FF',
      points: {
        show: false
      },
      lines: {
        show: true,
        fill: true
      },
      fillBetween: 'c25'
    }, {
      data: dat90,
      id: 'c90',
      color: '#a0a0FF',
      points: {
        show: false
      },
      lines: {
        show: true,
        fill: true
      },
      fillBetween: 'c75'
    }, {
      label: translate('High'),
      data: [],
      color: '#FFFF00',
    }, {
      label: translate('Low'),
      data: [],
      color: '#FF0000',
    }], {
      xaxis: {
        mode: 'time',
        timezone: 'browser',
        timeformat: '%H:%M',
        tickColor: '#555',
      },
      yaxis: {
        min: 0,
        max: options.units === 'mmol' ? 22: 400,
        tickColor: '#555',
      },
      grid: {
        markings: [{
          color: '#FF0000',
          lineWidth: 2,
          yaxis: {
            from: low,
            to: low
          }
        }, {
          color: '#FFFF00',
          lineWidth: 2,
          yaxis: {
            from: high,
            to: high
          }
        }],
        //hoverable: true
      }
    }
  );
};
