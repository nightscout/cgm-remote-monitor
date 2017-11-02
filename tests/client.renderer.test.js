'use strict';

require('should');
let _ = require('lodash');

let renderer = require('../lib/client/renderer');

describe('renderer', () => {
  describe('bubbleScale', () => {
    const MAX_DELTA = 0.0001;
    const PREV_CHART_WIDTHS = [
      { width: 400, expectedScale: 3.5 }
      , { width: 500, expectedScale: 2.625 }
      , { width: 900, expectedScale: 1.75 }
    ];

    _.forEach(PREV_CHART_WIDTHS, (prev) => {
      describe(`prevChartWidth < ${prev.width}`, () => {
        let mockClient = {
          utils: true
          , chart: { prevChartWidth: prev.width }
          , focusRangeMS: true
        };
        it('scales correctly', () => {
          renderer(mockClient, {}).bubbleScale().should.be.approximately(prev.expectedScale, MAX_DELTA);
        });
      });
    });
  });

  describe('highlightBrushPoints', () => {
    const BRUSH_EXTENTS = [
      { mills: 100, times: [200, 300], expectedOpacity: 0.5, expectation: 'Uses default opacity' }
      , { mills: 300, times: [100, 200], expectedOpacity: 0.5, expectation: 'Uses default opacity' }
      , { mills: 200, times: [100, 300], expectedOpacity: 1, expectation: 'Calculates opacity' }
    ];

    _.forEach(BRUSH_EXTENTS, (extent) => {
      let mockData = {
        mills: extent.mills
      };

      let mockClient = {
        chart: {
          brush: { 
            extent: () => {
              let extents = [];
              for (let time of extent.times) {
                extents.push({ getTime: () => {
                  return time;
                }});
              }
              return extents; 
            }
          }
          , futureOpacity: (millsDifference) => { return 1; }
        }
        , latestSGV: { mills: 120 }
      };

      describe(`data.mills ${extent.mills} and chart().brush.extent() times ${extent.times}`, () => {
        it(extent.expectation, () => {
          renderer(mockClient, {}).highlightBrushPoints(mockData).should.equal(extent.expectedOpacity);
        });
      });
    });
  });
});
