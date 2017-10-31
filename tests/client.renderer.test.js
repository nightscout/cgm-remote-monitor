'use strict';

require('should');
let _ = require('lodash');

let renderer = require('../lib/client/renderer');
const MAX_DELTA = 0.0001;
const PREV_CHART_WIDTHS = [
  { width: 400, expectedScale: 3.5 }
  , { width: 500, expectedScale: 2.625 }
  , { width: 900, expectedScale: 1.75 }
];

describe('renderer', () => {
  describe('bubbleScale', () => {
    _.forEach(PREV_CHART_WIDTHS, (prev) => {
      describe(`prevChartWidth < ${prev.width}`, () => {
        let mockClient = {
          utils: true
          , chart: { prevChartWidth: prev.width }
          , foucusRangeMS: true
        };
        it('scales correctly', () => {
          renderer(mockClient, {}).bubbleScale().should.be.approximately(prev.expectedScale, MAX_DELTA);
        });
      });
    });
  });
});
