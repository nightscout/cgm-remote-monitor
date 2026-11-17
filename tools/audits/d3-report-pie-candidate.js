// Research-only comparison using the D3 namespace already loaded by Nightscout.
// Not a production report replacement: no promise of Flot layout equivalence.
window.renderD3ReportPieCandidate = function (element, series) {
  var d3 = window.d3;
  var values = series.map(function (item) {
    return {label: item.label, color: item.color,
      value: typeof item.data === 'number' ? item.data : item.data.reduce(function (sum, point) { return sum + point[1]; }, 0)};
  });
  element.textContent = '';
  var svg = d3.select(element).append('svg').attr('viewBox', '0 0 600 240')
    .attr('role', 'img').attr('aria-label', 'Glucose distribution');
  var arcs = d3.pie().sort(null).value(function (item) {return item.value;})(values);
  svg.append('g').attr('transform', 'translate(120,120)').selectAll('path')
    .data(arcs).join('path').attr('d', d3.arc().innerRadius(0).outerRadius(110))
    .attr('fill', function (arc) {return arc.data.color;});
  svg.append('g').attr('transform', 'translate(260,60)').selectAll('text').data(values).join('text')
    .attr('y', function (item, index) {return index * 24;}).attr('fill', '#545454')
    .text(function (item) {return item.label + ': ' + item.value;});
  return arcs.map(function (arc) {return {label: arc.data.label, value: arc.value,
    startAngle: arc.startAngle, endAngle: arc.endAngle};});
};
