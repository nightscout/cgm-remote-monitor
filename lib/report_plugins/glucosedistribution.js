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
      '<h1>'
    + translate('Glucose distribution')
    + '  ('
    + '  <span id="glucosedistribution-days"></span>'
    + '  )'
    + '  </h1>'
    + '<div id="glucosedistribution-overviewchart"></div>'
    + '<div id="glucosedistribution-report"></div>'
    + '<br/>'
    + '<br/>'
    + '* ' + translate('This is only a rough estimation that can be very inaccurate and does not replace actual blood testing. The formula used is taken from: Nathan, David M., et al. "Translating the A1C assay into estimated average glucose values." <i>Diabetes care</i> 31.8 (2008): 1473-1478.')
    ;
  return ret;
};

glucosedistribution.report = function report_glucosedistribution(datastorage,daystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;

  var Statician = ss;
  var report = $('#glucosedistribution-report');
  report.empty();
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
  
  ['Low', 'Normal', 'High'].forEach(function(range) {
    var tr = $('<tr>');
    var rangeRecords = data.filter(function(r) {
      if (range === 'Low') {
        return r.sgv > 0 && r.sgv < options.targetLow;
      } else if (range === 'Normal') {
        return r.sgv >= options.targetLow && r.sgv < options.targetHigh;
      } else {
        return r.sgv >= options.targetHigh;
      }
    });
    stats.push(rangeRecords.length);
    rangeRecords.sort(function(a,b) {
      return a.sgv - b.sgv;
    });
    var localBgs = rangeRecords.map(function(r) { return r.sgv; }).filter(function(bg) { return !!bg; });

    var midpoint = Math.floor(rangeRecords.length / 2);
    //var statistics = ss.(new Statician(rangeRecords.map(function(r) { return r.sgv; }))).stats;

    $('<td class=\"tdborder\"><strong>' + translate(range) + ': </strong></td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.floor(100 * rangeRecords.length / data.length) + '%</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + rangeRecords.length + '</td>').appendTo(tr);
    if (rangeRecords.length > 0) {
      $('<td class=\"tdborder\">' + Math.floor(10*Statician.mean(localBgs))/10 + '</td>').appendTo(tr);
      $('<td class=\"tdborder\">' + rangeRecords[midpoint].sgv + '</td>').appendTo(tr);
      $('<td class=\"tdborder\">' + Math.floor(Statician.standard_deviation(localBgs)*10)/10 + '</td>').appendTo(tr);
      $('<td> </td>').appendTo(tr);
    } else {
      $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
      $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
      $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
      $('<td class=\"tdborder\"> </td>').appendTo(tr);
    }

    table.append(tr);
  });
  
  var tr = $('<tr>');
  $('<td class=\"tdborder\"><strong>'+translate('Overall')+': </strong></td>').appendTo(tr);
  $('<td> </td>').appendTo(tr);
  $('<td class=\"tdborder\">' + data.length + '</td>').appendTo(tr);
  if (data.length > 0) {
    var localBgs = data.map(function(r) { return r.sgv; }).filter(function(bg) { return !!bg; });
    var mgDlBgs = data.map(function(r) { return r.bgValue; }).filter(function(bg) { return !!bg; });
    $('<td class=\"tdborder\">' + Math.round(10*ss.mean(localBgs))/10 + '</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.round(10*ss.quantile(localBgs, 0.5))/10+ '</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.round(ss.standard_deviation(localBgs)*10)/10 + '</td>').appendTo(tr);
    $('<td class=\"tdborder\"><center>' + Math.round(10*(ss.mean(mgDlBgs)+46.7)/28.7)/10 + '%<sub>DCCT</sub> | ' +Math.round(((ss.mean(mgDlBgs)+46.7)/28.7 - 2.15)*10.929) + '<sub>IFCC</sub></center></td>').appendTo(tr);
  } else {
    $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
    $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
    $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
    $('<td class=\"tdborder\">N/A</td>').appendTo(tr);
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
        colors: ['#f88', '#8f8', '#ff8']
      }
    );
  });
};
