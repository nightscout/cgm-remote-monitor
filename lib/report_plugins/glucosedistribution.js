'use strict';

var glucosedistribution = {
  name: 'glucosedistribution'
  , label: 'Distribution'
  , pluginType: 'report'
};

function init() {
  return glucosedistribution;
}

module.exports = init;

glucosedistribution.html = function html(client) {
  var translate = client.translate;
  var ret =
      '<h2>'
    + translate('Glucose distribution')
    + '  ('
    + '  <span id="glucosedistribution-days"></span>'
    + '  )'
    + '  </h2>'
    + '<div id="glucosedistribution-overviewchart"></div>'
    + '<div id="glucosedistribution-report"></div>'
    + '<br/>'
    + '<br/>'
    + '* ' + translate('This is only a rough estimation that can be very inaccurate and does not replace actual blood testing. The formula used is taken from: Nathan, David M., et al. "Translating the A1C assay into estimated average glucose values." <i>Diabetes care</i> 31.8 (2008): 1473-1478.')
    ;
  return ret;
};

glucosedistribution.css =
    '#glucosedistribution-overviewchart {'
  + '  width: 2.4in;'
  + '  height: 2.4in;'
  + '  float:left;'
  + '}'
  + '#glucosedistribution-placeholder .tdborder {'
  + '  width:80px;'
  + '  border: 1px #ccc solid;'
  + '  margin: 0;'
  + '  padding: 1px;'
  + '	 text-align:center;'
  + '}'
  ;



glucosedistribution.report = function report_glucosedistribution(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;

  var ss = require('simple-statistics');

  var colors = ['#f88', '#8f8', '#ff8'];
  var tablecolors = { Low:'#f88', Normal: '#8f8', High: '#ff8' };
  
  var report = $('#glucosedistribution-report');
  report.empty();
  var stats = [];
  var table = $('<table class="centeraligned">');
  var thead = $('<tr/>');
  $('<th>'+translate('Range')+'</th>').appendTo(thead);
  $('<th>'+translate('% of Readings')+'</th>').appendTo(thead);
  $('<th>'+translate('# of Readings')+'</th>').appendTo(thead);
  $('<th>'+translate('Average')+'</th>').appendTo(thead);
  $('<th>'+translate('Median')+'</th>').appendTo(thead);
  $('<th>'+translate('Standard Deviation')+'</th>').appendTo(thead);
  $('<th>'+translate('A1c estimation*')+'</th>').appendTo(thead);
  thead.appendTo(table);

  var data = datastorage.allstatsrecords;
  var days = datastorage.alldays;
  
  $('#glucosedistribution-days').text(days+' '+translate('days total'));
  
  var result = { };

  ['Low', 'Normal', 'High'].forEach(function(range) {
    result[range] = { };
    var r = result[range];
    r.rangeRecords = data.filter(function(r) {
      if (range === 'Low') {
        return r.sgv > 0 && r.sgv < options.targetLow;
      } else if (range === 'Normal') {
        return r.sgv >= options.targetLow && r.sgv < options.targetHigh;
      } else {
        return r.sgv >= options.targetHigh;
      }
    });
    stats.push(r.rangeRecords.length);
    r.rangeRecords.sort(function(a,b) {
      return a.sgv - b.sgv;
    });
    r.localBgs = r.rangeRecords.map(function(r) { return r.sgv; }).filter(function(bg) { return !!bg; });
    r.midpoint = Math.floor(r.rangeRecords.length / 2);
    r.readingspct = Math.floor(100 * r.rangeRecords.length / data.length);
    if (r.rangeRecords.length > 0) {
      r.mean = Math.floor(10*ss.mean(r.localBgs))/10;
      r.median = r.rangeRecords[r.midpoint].sgv;
      r.stddev = Math.floor(ss.standard_deviation(r.localBgs)*10)/10;
    }
  });

  // make sure we have total 100%
  result.Normal.readingspct = 100 - result.Low.readingspct - result.High.readingspct;
  
  ['Low', 'Normal', 'High'].forEach(function(range) {
    var tr = $('<tr>');
    var r = result[range];

    $('<td class="tdborder" style="background-color:' + tablecolors[range] + '"><strong>' + translate(range) + ': </strong></td>').appendTo(tr);
    $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + r.rangeRecords.length + '</td>').appendTo(tr);
    if (r.rangeRecords.length > 0) {
      $('<td class="tdborder">' + r.mean.toFixed(1) + '</td>').appendTo(tr);
      $('<td class="tdborder">' + r.median.toFixed(1) + '</td>').appendTo(tr);
      $('<td class="tdborder">' + r.stddev.toFixed(1) + '</td>').appendTo(tr);
      $('<td> </td>').appendTo(tr);
    } else {
      $('<td class="tdborder">N/A</td>').appendTo(tr);
      $('<td class="tdborder">N/A</td>').appendTo(tr);
      $('<td class="tdborder">N/A</td>').appendTo(tr);
      $('<td class="tdborder"> </td>').appendTo(tr);
    }

    table.append(tr);
  });
  
  var tr = $('<tr>');
  $('<td class="tdborder"><strong>'+translate('Overall')+': </strong></td>').appendTo(tr);
  $('<td> </td>').appendTo(tr);
  $('<td class="tdborder">' + data.length + '</td>').appendTo(tr);
  if (data.length > 0) {
    var localBgs = data.map(function(r) { return r.sgv; }).filter(function(bg) { return !!bg; });
    var mgDlBgs = data.map(function(r) { return r.bgValue; }).filter(function(bg) { return !!bg; });
    $('<td class="tdborder">' + (Math.round(10*ss.mean(localBgs))/10).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + (Math.round(10*ss.quantile(localBgs, 0.5))/10).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + (Math.round(ss.standard_deviation(localBgs)*10)/10).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder"><center>' + (Math.round(10*(ss.mean(mgDlBgs)+46.7)/28.7)/10).toFixed(1) + '%<sub>DCCT</sub> | ' + Math.round(((ss.mean(mgDlBgs)+46.7)/28.7 - 2.15)*10.929) + '<sub>IFCC</sub></center></td>').appendTo(tr);
  } else {
    $('<td class="tdborder">N/A</td>').appendTo(tr);
    $('<td class="tdborder">N/A</td>').appendTo(tr);
    $('<td class="tdborder">N/A</td>').appendTo(tr);
    $('<td class="tdborder">N/A</td>').appendTo(tr);
  }
  table.append(tr);
  report.append(table);

  setTimeout(function() {
    $.plot(
      '#glucosedistribution-overviewchart',
      stats,
      {
        series: {
          pie: {
            show: true
          }
        },
        colors: colors
      }
    );
  });
};
