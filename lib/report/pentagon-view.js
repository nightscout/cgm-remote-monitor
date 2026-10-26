'use strict';

const model = require('./pentagon');
const coverage = require('./agp-data');
const constants = require('../constants');
const SVG = 'http://www.w3.org/2000/svg';

function element(name, attributes, text) {
  const node = document.createElementNS(SVG, name);
  Object.keys(attributes || {}).forEach(key => node.setAttribute(key, attributes[key]));
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(container, records, days, profile, moment, units, translate, allHours) {
  container.empty();
  const heading = $('<h3>').text(translate('Comprehensive Glucose Pentagon'));
  container.append(heading);
  if (!allHours) {
    container.append($('<p class="gd-pentagon-message">').text(translate('Select all 24 hours to calculate the glucose pentagon.')));
    return;
  }
  const prepared = coverage.prepare(records || [], days || [], profile, moment);
  const result = model.calculate(prepared, profile);
  container.append($('<p class="gd-pentagon-coverage">').text(
    translate('CGM coverage') + ': ' + result.coverage.toFixed(1) + '% · ' + result.count + ' ' + translate('readings') + ' · ' + result.days + ' ' + translate('days')
  ));
  if (!result.available) {
    const message = result.reason === 'empty' ? 'No glucose readings in the selected period.'
      : result.reason === 'coverage' ? 'At least 70% CGM coverage is required to show the pentagon.'
        : 'The glucose pentagon could not be calculated.';
    container.append($('<p class="gd-pentagon-message">').text(translate(message)));
    return;
  }

  const mmol = String(units).toLowerCase().startsWith('mmol');
  const unit = mmol ? 'mmol/L' : 'mg/dL';
  const convert = value => mmol ? value / constants.MMOL_TO_MGDL : value;
  const fmtGlucose = value => mmol ? convert(value).toFixed(1) : value.toFixed(0);
  const names = ['Time out of range', 'Glucose variability', 'Low glucose intensity', 'High glucose intensity', 'Mean glucose'].map(name => translate(name));
  const values = [result.values[0].toFixed(0) + ' ' + translate('min/day'), result.values[1].toFixed(1) + '%',
    convert(result.values[2] / 1000).toFixed(2) + ' × 1,000 ' + unit + '·min²',
    convert(result.values[3] / 1000).toFixed(2) + ' × 1,000 ' + unit + '·min²', fmtGlucose(result.values[4]) + ' ' + unit];

  const body = $('<div class="gd-pentagon-body">');
  const svg = element('svg', {viewBox: '0 0 600 500', role: 'img', 'aria-labelledby': 'gd-pentagon-title gd-pentagon-description'});
  svg.appendChild(element('title', {id: 'gd-pentagon-title'}, translate('Comprehensive Glucose Pentagon')));
  svg.appendChild(element('desc', {id: 'gd-pentagon-description'}, translate('A five-axis comparison with the reference pentagon. Values are listed beside the chart.')));
  const center = [300, 245], radius = 150;
  function point(index, distance) {
    const angle = index * Math.PI * 2 / 5;
    return [center[0] + Math.sin(angle) * distance, center[1] - Math.cos(angle) * distance];
  }
  function polygon(axes, cls) {
    const points = axes.map((value, index) => point(index, radius * Math.min(76, value) / 76).map(n => n.toFixed(2)).join(',')).join(' ');
    svg.appendChild(element('polygon', {points, class: cls}));
  }
  polygon([76, 76, 76, 76, 76], 'gd-pentagon-outline');
  names.forEach((name, index) => {
    const end = point(index, radius);
    svg.appendChild(element('line', {x1: center[0], y1: center[1], x2: end[0], y2: end[1], class: 'gd-pentagon-axis'}));
    const label = point(index, radius + 20);
    const anchor = index === 0 ? 'middle' : index < 3 ? 'start' : 'end';
    svg.appendChild(element('text', {x: label[0], y: label[1], 'text-anchor': anchor, class: 'gd-pentagon-label'}, name));
  });
  polygon(result.reference, 'gd-pentagon-reference');
  polygon(result.axes, 'gd-pentagon-patient');
  result.axes.forEach((value, index) => {
    if (value > 76) {
      const pt = point(index, radius);
      svg.appendChild(element('circle', {cx: pt[0], cy: pt[1], r: 5, class: 'gd-pentagon-overflow'}));
    }
  });
  body.append($('<div class="gd-pentagon-chart">').append(svg));
  const details = $('<div class="gd-pentagon-details">');
  details.append($('<p class="gd-pentagon-score">').text('PGR: ' + result.score.toFixed(2)));
  const list = $('<dl class="gd-pentagon-values">');
  names.forEach((name, index) => { list.append($('<dt>').text(name)); list.append($('<dd>').text(values[index])); });
  details.append(list);
  details.append($('<p class="gd-pentagon-legend">').text(translate('Green: reference · Yellow: selected data · Dots: values beyond chart scale')));
  body.append(details); container.append(body);
  container.append($('<p class="gd-pentagon-note">').text(translate('Estimated from observed readings using fixed thresholds:') + ' ' + fmtGlucose(70) + '–' + fmtGlucose(180) + ' ' + unit + '. ' + translate('Missing time is not filled. PGR is a research metric and is not a validated prediction of individual complications.')));
  container.append($('<p class="gd-pentagon-note">').append($('<a>').attr({href: 'https://doi.org/10.1177/1932296817718561', target: '_blank', rel: 'noopener noreferrer'}).text(translate('Glucose Pentagon: original study'))));
}

module.exports = {render};
