'use strict';

// Presentation of the existing daily totals; no dose or nutrition calculation.
module.exports = function dailyDistribution(host, values, translate, d3) {
  const $ = window.$;
  host.empty().addClass('daily-distribution');
  const basal = values.basal, bolus = values.bolus, total = basal + bolus;
  const validInsulin = Number.isFinite(basal) && basal >= 0 && Number.isFinite(bolus) && bolus >= 0 && Number.isFinite(total);
  const hasInsulin = validInsulin && total > 0;
  const insulin = $('<section class="daily-insulin-card">').appendTo(host);
  $('<h3>').text(translate('Insulin distribution')).appendTo(insulin);
  $('<p class="daily-summary-caption">').text(translate('Basal and bolus share of daily total')).appendTo(insulin);
  const body = $('<div class="daily-insulin-body">').appendTo(insulin);
  const chart = d3.select(body[0]).append('svg').attr('class', 'daily-insulin-ring')
    .attr('viewBox', '0 0 160 160').attr('role', 'img');
  const basalPct = hasInsulin ? Math.round(basal / total * 1000) / 10 : 0;
  const slices = [
    {label: translate('Basal'), amount: basal, pct: basalPct, color: '#347de1'},
    {label: translate('Bolus'), amount: bolus, pct: hasInsulin ? Math.round((100 - basalPct) * 10) / 10 : 0, color: '#925bd7'}
  ];
  const totalText = validInsulin ? total.toFixed(1) : '—';
  chart.attr('aria-label', translate('Total daily insulin:') + ' ' + totalText + ' U' + (hasInsulin ? '. ' +
    slices.map(slice => slice.label + ': ' + slice.amount.toFixed(1) + ' U (' + slice.pct.toFixed(1) + '%)').join('. ') : ''));
  chart.append('circle').attr('cx', 80).attr('cy', 80).attr('r', 57)
    .attr('fill', 'none').attr('stroke', '#edf1f6').attr('stroke-width', 16);
  if (hasInsulin) {
    const nonzero = slices.filter(slice => slice.amount > 0);
    const arc = d3.arc().innerRadius(49).outerRadius(65).cornerRadius(4)
      .padAngle(nonzero.length > 1 ? 0.035 : 0);
    chart.append('g').attr('transform', 'translate(80,80)').selectAll('path')
      .data(d3.pie().value(slice => slice.amount).sort(null)(nonzero)).enter().append('path')
      .attr('d', arc).attr('fill', slice => slice.data.color)
      .append('title').text(slice => slice.data.label + ': ' + slice.data.amount.toFixed(1) + ' U · ' + slice.data.pct.toFixed(1) + '%');
  }
  chart.append('text').attr('x', 80).attr('y', 78).attr('class', 'daily-insulin-total').attr('text-anchor', 'middle').text(totalText);
  chart.append('text').attr('x', 80).attr('y', 98).attr('class', 'daily-insulin-unit').attr('text-anchor', 'middle').text(translate('U total'));
  if (hasInsulin) {
    const legend = $('<div class="daily-insulin-legend">').appendTo(body);
    slices.forEach(slice => {
      const row = $('<div class="daily-insulin-key">').appendTo(legend);
      $('<span class="daily-summary-swatch" aria-hidden="true">').css('background-color', slice.color).appendTo(row);
      const name = $('<span class="daily-insulin-name">').text(slice.label).appendTo(row);
      $('<small>').text(slice.pct.toFixed(1) + '%').appendTo(name);
      $('<strong>').text(slice.amount.toFixed(1) + ' U').appendTo(row);
    });
  } else {
    $('<p class="daily-summary-caption">').text(translate(validInsulin ? 'No insulin recorded' : 'Insulin breakdown unavailable')).appendTo(insulin);
  }

  if (values.positiveTemps > 0 || values.negativeTemps < 0) {
    const details = $('<details class="daily-basal-adjustments">').appendTo(insulin);
    $('<summary>').text(translate('Basal adjustments')).appendTo(details);
    const list = $('<dl>').appendTo(details);
    [[translate('Base basal insulin:'), values.baseBasal], [translate('Positive temp basal insulin:'), values.positiveTemps],
      [translate('Negative temp basal insulin:'), values.negativeTemps]].forEach(([label, value]) => {
      $('<dt>').text(label).appendTo(list);
      $('<dd>').text(Number.isFinite(value) ? value.toFixed(1) + ' U' : '—').appendTo(list);
    });
  }

  const carbs = values.carbs, maximum = values.maxCarbs;
  const validCarbs = Number.isFinite(carbs) && carbs >= 0;
  const nutrition = $('<section class="daily-carbs-card">').appendTo(host);
  $('<h3>').text(translate('Recorded carbs')).appendTo(nutrition);
  function grams(value) {return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);}
  const amount = $('<div class="daily-carbs-total">').text(validCarbs ? grams(carbs) : '—').appendTo(nutrition);
  $('<span>').text(' g').appendTo(amount);
  $('<p class="daily-summary-caption">').text(translate(validCarbs && carbs === 0 ? 'No carbs recorded' : 'Daily carbohydrate total')).appendTo(nutrition);
  const hasMacros = Number.isFinite(values.protein) && Number.isFinite(values.fat);
  const hasComparison = validCarbs && Number.isFinite(maximum) && maximum > 0 && maximum >= carbs;
  if (hasMacros || hasComparison) {
    const details = $('<details class="daily-nutrition-details">').appendTo(nutrition);
    $('<summary>').text(translate('Details')).appendTo(details);
    if (hasMacros) {
      $('<p class="daily-macro-totals">').text(translate('Total protein') + ': ' + grams(values.protein) + ' g · ' +
        translate('Total fat') + ': ' + grams(values.fat) + ' g').appendTo(details);
    }
    if (hasComparison) {
      const track = $('<div class="daily-carbs-track" aria-hidden="true">').appendTo(details);
      $('<span>').css('width', (carbs / maximum * 100) + '%').appendTo(track);
      $('<p class="daily-carbs-comparison">').text(translate('Highest selected day') + ': ' + grams(maximum) + ' g').appendTo(details);
    }
  }
};
