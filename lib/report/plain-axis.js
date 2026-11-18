'use strict';

// d3 axes write presentation attributes (fill, stroke, font-*, text-anchor, opacity)
// into the SVG. Report charts style axes in report.css instead, so remove them
// after drawing and mark the axis with .report-axis and its orientation.
// (.x / .y are not used here: daytoday and its tests select the glucose axes by them.)
// Usage: selection.call(axis).call(plainAxis, 'bottom');
function plainAxis (selection, orientation) {
  selection
    .attr('fill', null)
    .attr('font-size', null)
    .attr('font-family', null)
    .attr('text-anchor', null)
    .classed('report-axis', true)
    .classed('report-axis-' + orientation, true);
  selection.selectAll('.tick').attr('opacity', null);
  selection.selectAll('.domain, .tick line').attr('stroke', null);
  selection.selectAll('.tick text').attr('fill', null);
}

module.exports = plainAxis;
