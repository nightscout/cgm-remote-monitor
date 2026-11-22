'use strict';

// Report charts position everything on whole pixels. Lists every rendered
// coordinate (x/y attributes, transforms, polyline points and path data) that
// still carries a fractional part. Relative text offsets in em (dy) are not
// pixel coordinates and are ignored.
const POSITION_ATTRIBUTES = ['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy'];
const NUMBER_LISTS = ['d', 'points', 'transform'];
const FRACTION = /\.\d/;

function fractionalCoordinates (root) {
  const found = [];
  root.querySelectorAll('svg *').forEach(function (node) {
    POSITION_ATTRIBUTES.forEach(function (name) {
      const value = node.getAttribute(name);
      if (value === null || value.endsWith('%')) return;
      if (!Number.isInteger(Number(value))) found.push(node.tagName + '[' + name + '="' + value + '"]');
    });
    NUMBER_LISTS.forEach(function (name) {
      const value = node.getAttribute(name);
      if (value && FRACTION.test(value)) found.push(node.tagName + '[' + name + '="' + value + '"]');
    });
  });
  return found;
}

// Presentation attributes that report.css provides instead.
const STYLING_ATTRIBUTE = /^(?:r$|fill|stroke|opacity|font|text-anchor|dominant-baseline|clip-path|stop-|shape-rendering|vector-effect|paint-order)/;

function stylingAttributes (root) {
  const found = [];
  root.querySelectorAll('svg, svg *').forEach(function (node) {
    Array.from(node.attributes).forEach(function (attribute) {
      if (STYLING_ATTRIBUTE.test(attribute.name)) found.push(node.tagName + '[' + attribute.name + '="' + attribute.value + '"]');
    });
  });
  return found;
}

module.exports = { fractionalCoordinates, stylingAttributes };
