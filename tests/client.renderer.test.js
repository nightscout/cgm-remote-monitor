'use strict';

require('should');

let renderer = require('../lib/client/renderer');

describe('renderer', () => {
  describe('bubbleScale', () => {
    const MAX_DELTA = 0.0001;
    const PREV_CHART_WIDTHS = [
      { width: 400, expectedScale: 3.5 }
      , { width: 500, expectedScale: 2.625 }
      , { width: 900, expectedScale: 1.75 }    ];

    PREV_CHART_WIDTHS.forEach((prev) => {
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
      , { mills: 200, times: [100, 300], expectedOpacity: 1, expectation: 'Calculates opacity' }    ];

    BRUSH_EXTENTS.forEach((extent) => {
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
          , createAdjustedRange: () => { return [
            { getTime: () => { return extent.times[0]}},
            { getTime: () => { return extent.times[1]}}
          ] }
        }
        , latestSGV: { mills: 120 }
      };

      describe(`data.mills ${extent.mills} and chart().brush.extent() times ${extent.times}`, () => {
        it(extent.expectation, () => {
          var selectedRange = mockClient.chart.createAdjustedRange();
          var from = selectedRange[0].getTime();
          var to = selectedRange[1].getTime();
          renderer(mockClient, {}).highlightBrushPoints(mockData, from, to).should.equal(extent.expectedOpacity);
        });
      });
    });
  });

  describe('glucoseLineSegments', () => {
    const MIN = 5 * 60 * 1000;   // 5 minutes in ms
    const GAP = 15 * 60 * 1000;  // 15-minute split threshold in ms

    function sgv (mills) {
      return { type: 'sgv', mills: mills };
    }

    it('returns no segments for empty input', () => {
      renderer({}, {}).glucoseLineSegments([], GAP).should.eql([]);
    });

    it('returns no segments when entries is undefined', () => {
      renderer({}, {}).glucoseLineSegments(undefined, GAP).should.eql([]);
    });

    it('ignores entries that are not sgv readings', () => {
      let entries = [
        { type: 'mbg', mills: 0 }
        , { type: 'rawbg', mills: MIN }
        , { type: 'forecast', mills: 2 * MIN }
      ];
      renderer({}, {}).glucoseLineSegments(entries, GAP).should.eql([]);
    });

    it('keeps closely-spaced readings in a single segment', () => {
      let entries = [sgv(0), sgv(MIN), sgv(2 * MIN), sgv(3 * MIN)];
      let segments = renderer({}, {}).glucoseLineSegments(entries, GAP);
      segments.length.should.equal(1);
      segments[0].length.should.equal(4);
    });

    it('splits into separate segments where a gap exceeds the threshold', () => {
      let entries = [sgv(0), sgv(MIN), sgv(MIN + 30 * 60 * 1000), sgv(MIN + 35 * 60 * 1000)];
      let segments = renderer({}, {}).glucoseLineSegments(entries, GAP);
      segments.length.should.equal(2);
      segments[0].length.should.equal(2);
      segments[1].length.should.equal(2);
    });

    it('sorts unordered readings by time before segmenting', () => {
      let entries = [sgv(2 * MIN), sgv(0), sgv(MIN)];
      let segments = renderer({}, {}).glucoseLineSegments(entries, GAP);
      segments.length.should.equal(1);
      segments[0].map(d => d.mills).should.eql([0, MIN, 2 * MIN]);
    });
  });
});
