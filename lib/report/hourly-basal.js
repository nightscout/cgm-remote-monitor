'use strict';

module.exports = function hourlyBasal (host, data, days, client, localeDate, calculate) {
  const $ = window.$, translate = client.translate;
  const rows = days.map(day => ({day, stats: calculate(day)}));
  const usable = rows.filter(row => row.stats && row.stats.positive.some(Number.isFinite)).length;
  const section = $('<section id="hourly-basal-adjustments">').appendTo(host);
  $('<h2>').text(translate('Hourly basal adjustments (U)')).appendTo(section);
  $('<p>').text(translate('Each hour shows reduced basal, additional basal and the net adjustment, in units (U), calculated from uploaded temporary basals and the basal profile.')).appendTo(section);
  if (!usable) {
    $('<p class="hourly-basal-unavailable" role="status">').text(translate(days.length ?
      'Basal profile data is unavailable for this period. Hourly basal adjustments cannot be calculated.' :
      'No report data is available for this period.')).appendTo(section);
    return;
  }
  $('<p class="hourly-basal-legend">').text(translate('Averages use available days for each hour. Counts in parentheses show days with a net reduction or increase. A dash means unavailable data or an hour skipped by daylight saving; repeated hours are combined. Hours follow the report timezone.')).appendTo(section);
  const scroll = $('<div class="hourly-basal-scroll" tabindex="0" role="region">')
    .attr('aria-label', translate('Hourly basal adjustments')).appendTo(section);
  const table = $('<table class="hourly-basal-table">').appendTo(scroll);
  const head = $('<tr>').appendTo($('<thead>').appendTo(table));
  $('<th scope="col">').text(translate('Date')).appendTo(head);
  for (let hour = 0; hour < 24; hour++) $('<th scope="col">').text(hour).appendTo(head);
  const body = $('<tbody>').appendTo(table);
  const totals = Array.from({length: 24}, () => ({positive: 0, negative: 0, count: 0, increases: 0, reductions: 0}));
  function cell (row, positive, negative, counts) {
    const td = $('<td>').appendTo(row);
    if (!Number.isFinite(positive) || !Number.isFinite(negative)) return td.text('—').attr('title', translate('Not available'));
    const net = positive + negative;
    td.addClass(Math.abs(net) < .005 ? 'is-neutral' : net < 0 ? 'is-negative' : 'is-positive');
    [[negative, 'Reduced basal', 'basal-reduced', counts && counts.reductions],
      [positive, 'Additional basal', 'basal-added', counts && counts.increases],
      [net, 'Net adjustment', 'basal-net']].forEach(([value, label, className, count]) => {
      $('<span>').addClass(className).attr('title', translate(label) + ' (U)')
        .text((Math.abs(value) < .005 ? 0 : value).toFixed(2) + (counts && count !== undefined ? ' (' + count + ')' : '')).appendTo(td);
    });
    return td;
  }
  rows.forEach(({day, stats}) => {
    const row = $('<tr>').appendTo(body);
    $('<th scope="row">').text(localeDate(day)).appendTo(row);
    for (let hour = 0; hour < 24; hour++) {
      const positive = stats && stats.positive[hour], negative = stats && stats.negative[hour];
      cell(row, positive, negative);
      if (!Number.isFinite(positive) || !Number.isFinite(negative)) continue;
      const total = totals[hour], net = positive + negative;
      total.positive += positive; total.negative += negative; total.count++;
      if (net > 1e-9) total.increases++;
      if (net < -1e-9) total.reductions++;
    }
  });
  const average = $('<tr class="hourly-basal-average">').appendTo($('<tfoot>').appendTo(table));
  $('<th scope="row">').text(translate('Average') + ' ' + usable + ' ' + translate('days')).appendTo(average);
  totals.forEach(total => cell(average, total.count ? total.positive / total.count : null,
    total.count ? total.negative / total.count : null, total));
  if (!(data.tempbasalTreatments || []).length) {
    $('<p class="hourly-basal-empty">').text(translate('No temporary basal records were loaded for this period; no basal adjustments were recorded.')).appendTo(section);
  }
};
