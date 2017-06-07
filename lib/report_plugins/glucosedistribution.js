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
    + '<div id="glucosedistribution-stability"></div>'
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

  var stability = $('#glucosedistribution-stability');
  stability.empty();
  
  var stats = [];
  var table = $('<table class="centeraligned">');
  var thead = $('<tr/>');
  $('<th>'+translate('Range')+'</th>').appendTo(thead);
  $('<th>'+translate('% of Readings')+'</th>').appendTo(thead);
  $('<th>'+translate('# of Readings')+'</th>').appendTo(thead);
  $('<th>'+translate('Mean')+'</th>').appendTo(thead);
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
    r.readingspct = (100 * r.rangeRecords.length / data.length).toFixed(1);
    if (r.rangeRecords.length > 0) {
      r.mean = Math.floor(10*ss.mean(r.localBgs))/10;
      r.median = r.rangeRecords[r.midpoint].sgv;
      r.stddev = Math.floor(ss.standard_deviation(r.localBgs)*10)/10;
    }
  });
  
  // make sure we have total 100%
  result.Normal.readingspct = (100 - result.Low.readingspct - result.High.readingspct).toFixed(1);
  
  ['Low', 'Normal', 'High'].forEach(function(range) {
    var tr = $('<tr>');
    var r = result[range];
    
    var rangeExp = '';
    
    if (range == 'Low') {rangeExp = ' (<' + options.targetLow + ')';}
    if (range == 'High') {rangeExp = ' (>=' + options.targetHigh + ')';}

    $('<td class="tdborder" style="background-color:' + tablecolors[range] + '"><strong>' + translate(range) + rangeExp + ': </strong></td>').appendTo(tr);
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


   // Stability
   
   var t1 = 6;
   var t2 = 11;
   var t1count = 0;
   var t2count = 0;
   
   var total = 0;
   
   var stabilitytable = $('<table>');
   
   var t1exp = '>5 mg/dl/5m';
   var t2exp = '>10 mg/dl/5m';
   
   if (localStorage.units == 'mmol') {
   	t1exp = '>0.27 mmol/l/5m';
    t2exp = '>0.55 mmol/l/5m';
   
   }
   
   console.log(localStorage.units);
   
   $('<tr><th>' + translate('Mean Absolute Change') + '</th><th>' + translate('Time in fluctuation') + '<br>('+t1exp+')</th><th>'+ translate('Time in rapid fluctuation') + '<br>('+t2exp+')</th></tr>').appendTo(stabilitytable);
   
   console.log(data[0]);
   
   for (var i = 0; i < data.length-2; i++) {
   
     var entry = data[i];
     var nextEntry = data[i+1];
     
     var timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();
     
     if (timeDelta > 6 * 60 * 1000) { console.log("Record skipped"); continue; }
     
     var delta = Math.abs(nextEntry.bgValue - entry.bgValue);
     
     total += delta;
     
     if (delta >= t1) { t1count += 1; }
     if (delta >= t2) { t2count += 1; }
   }
   
   var timeInT1 = Math.round(100 * t1count / data.length).toFixed(1);
   var timeInT2 = Math.round(100 * t2count / data.length).toFixed(1);
   var mac = (total / data.length).toFixed(1);
   
   if(localStorage.units == 'mmol') { mac = (total / data.length / 18.0).toFixed(2); }
  
  $('<tr><td class="tdborder">' + mac + '</td><td class="tdborder">' + timeInT1 + '%</td><td class="tdborder">' + timeInT2 + '%</td></tr>').appendTo(stabilitytable);
  stabilitytable.appendTo(stability);

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
