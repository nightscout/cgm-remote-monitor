'use strict';

var times = require('../times');

var success = {
  name: 'success'
  , label: 'Weekly success'
  , pluginType: 'report'
};

function init() {
  return success;
}

module.exports = init;

success.html = function html(client) {
  var translate = client.translate;
  var ret =
     '<h1>' + translate('Weekly Success') + '</h1>'
    + '<div id="success-grid"></div>'
    ;
  return ret;
};

success.css = 
  '#success-placeholder td {'+
  '	border: 1px #ccc solid;'+
  '	margin: 0;'+
  '	padding: 1px;'+
  ' text-align:center;'+
  '}'+
  '#success-placeholder .bad {'+
  '	background-color: #fcc;'+
  '}'+

  '#success-placeholder .good {'+
  '	background-color: #cfc;'+
  '}'+

  '#success-placeholder th:first-child {'+
  '	width: 30%;'+
  '}'+
  '#success-placeholder th {'+
  '	width: 10%;'+
  '}'+
  '#success-placeholder table {'+
  '	width: 100%;'+
  '}'
  ;



success.report = function report_success(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;

  var ss = require('simple-statistics');

  var low = options.targetLow,
    high = options.targetHigh;

  var data = datastorage.allstatsrecords;
    
  var now = Date.now();
  var period = 7 * times.hours(24).msecs;
  var firstDataPoint = data.reduce(function(min, record) {
      return Math.min(min, record.displayTime);
    }, Number.MAX_VALUE);
  if (firstDataPoint < 1390000000000) {
    firstDataPoint = 1390000000000;
  }
  var quarters = Math.floor((Date.now() - firstDataPoint) / period);

  var grid = $('#success-grid');
  grid.empty();
  var table = $('<table/>');

  if (quarters === 0) {
    // insufficent data
    grid.append('<p>'+translate('There is not sufficient data to run this report. Select more days.')+'</p>');
    return;
  }

  var dim = function(n) {
    var a = [];
    for (var i = 0; i < n; i++) {
      a[i]=0;
    }
    return a;
  };
  var sum = function(a) {
    return a.reduce(function(sum,v) {
      return sum+v;
    }, 0);
  };
  var averages = {
    percentLow: 0,
    percentInRange: 0,
    percentHigh: 0,
    standardDeviation: 0,
    lowerQuartile: 0,
    upperQuartile: 0,
    average: 0
  };
  quarters = dim(quarters).map(function(blank, n) {
    var starting = new Date(now - (n+1) * period),
      ending = new Date(now - n * period);
    return {
      starting: starting,
      ending: ending,
      records: data.filter(function(record) {
        return record.displayTime > starting &&  record.displayTime <= ending;
      })
    };
  }).filter(function(quarter) {
    return quarter.records.length > 0;
  }).map(function(quarter, ix, all) {
    var bgValues = quarter.records.map(function(record) {
      return record.sgv;
    });
    quarter.standardDeviation = ss.standard_deviation(bgValues);
    quarter.average = bgValues.length > 0? (sum(bgValues) / bgValues.length): 'N/A';
    quarter.lowerQuartile = ss.quantile(bgValues, 0.25); 
    quarter.upperQuartile = ss.quantile(bgValues, 0.75);
    quarter.numberLow = bgValues.filter(function(bg) {
      return bg < low;
    }).length;
    quarter.numberHigh = bgValues.filter(function(bg) {
      return bg >= high;
    }).length;
    quarter.numberInRange = bgValues.length - (quarter.numberHigh + quarter.numberLow);

    quarter.percentLow = (quarter.numberLow / bgValues.length) * 100;
    quarter.percentInRange = (quarter.numberInRange / bgValues.length) * 100;
    quarter.percentHigh = (quarter.numberHigh / bgValues.length) * 100;

    averages.percentLow += quarter.percentLow / all.length;
    averages.percentInRange += quarter.percentInRange / all.length;
    averages.percentHigh += quarter.percentHigh / all.length;
    averages.lowerQuartile += quarter.lowerQuartile / all.length;
    averages.upperQuartile += quarter.upperQuartile / all.length;
    averages.average += quarter.average / all.length;
    averages.standardDeviation += quarter.standardDeviation / all.length;
    return quarter;
  });

  var lowComparison = function(quarter, averages, field, invert) {
    if (quarter[field] < averages[field] * 0.8) {
      return (invert? 'bad': 'good');
    } else if (quarter[field] > averages[field] * 1.2) {
      return (invert? 'good': 'bad');
    } else {
      return '';
    }
  };

  var lowQuartileEvaluation = function(quarter, averages) {
    if (quarter.lowerQuartile < low) {
      return 'bad';
    } else {
      return lowComparison(quarter, averages, 'lowerQuartile');
    }
  };

  var upperQuartileEvaluation = function(quarter, averages) {
    if (quarter.upperQuartile > high) {
      return 'bad';
    } else {
      return lowComparison(quarter, averages, 'upperQuartile');
    }
  };

  table.append('<thead><tr><th>'+translate('Period')+'</th><th>'+translate('Low')+'</th><th>'+translate('In Range')+'</th><th>'+translate('High')+'</th><th>'+translate('Standard Deviation')+'</th><th>'+translate('Low Quartile')+'</th><th>'+translate('Average')+'</th><th>'+translate('Upper Quartile')+'</th></tr></thead>');
  table.append('<tbody>' + quarters.filter(function(quarter) {
    return quarter.records.length > 0;
  }).map(function(quarter) {
    var INVERT = true;
    return '<tr>' + [
      quarter.starting.toLocaleDateString() + ' - ' + quarter.ending.toLocaleDateString(),
      {
        klass: lowComparison(quarter, averages, 'percentLow'),
        text: Math.round(quarter.percentLow) + '%'
      },
      {
        klass: lowComparison(quarter, averages, 'percentInRange', INVERT),
        text: Math.round(quarter.percentInRange) + '%'
      },
      {
        klass: lowComparison(quarter, averages, 'percentHigh'),
        text: Math.round(quarter.percentHigh) + '%'
      },
      {
        klass: lowComparison(quarter, averages, 'standardDeviation'),
        text: (quarter.standardDeviation > 10? Math.round(quarter.standardDeviation): quarter.standardDeviation.toFixed(1))
      },
      {
        klass: lowQuartileEvaluation(quarter, averages),
        text: quarter.lowerQuartile
      },
      {
        klass: lowComparison(quarter, averages, 'average'),
        text: quarter.average.toFixed(1)
      },
      {
        klass: upperQuartileEvaluation(quarter, averages),
        text: quarter.upperQuartile
      }
    ].map(function(v) {
      if (typeof v === 'object') {
        return '<td class=\"' + v.klass + '\">' + v.text + '</td>';
      } else {
        return '<td>' + v + '</td>';
      }
    }).join('') + '</tr>';
  }).join('') + '</tbody>');
  table.appendTo(grid);

};