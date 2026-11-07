'use strict';

/**
 * Pill-output goldens.
 *
 * For each captured-fixture source under tests/fixtures/captured/<source>/,
 * re-runs the pill-emitting plugin chain and asserts the output matches
 * tests/fixtures/captured/<source>/pills-golden.json.
 *
 * To intentionally update goldens after a behavior change:
 *   node tools/captured-fixtures/generate-pill-goldens.js --write
 *   git diff tests/fixtures/captured/<source>/pills-golden.json  # review
 *   git add  tests/fixtures/captured/<source>/pills-golden.json
 *
 * Why this test exists:
 *   See L1 + L4 in docs/proposals/testing-modernization-proposal.md and
 *   docs/test-specs/coverage-gaps.md. This is the cheapest, most leveraged
 *   regression net for any refactor that touches the plugin chain.
 */

const fs = require('fs');
const path = require('path');
const should = require('should');
const { captureRun, stableStringify, defaultSources } = require('../../tools/captured-fixtures/pill-runner');

const ROOT = path.resolve(__dirname, '..', '..');

describe('captured-fixture pill goldens', function () {
  const sources = defaultSources(ROOT);
  if (!sources.length) {
    it('finds captured-fixture sources', function () {
      throw new Error('No captured-fixture sources found under tests/fixtures/captured/');
    });
    return;
  }

  for (const sourceDir of sources) {
    const sourceName = path.basename(sourceDir);
    const goldenPath = path.join(sourceDir, 'pills-golden.json');

    describe(sourceName, function () {
      it('matches committed pills-golden.json', function () {
        if (!fs.existsSync(goldenPath)) {
          throw new Error(
            `Missing golden: ${path.relative(ROOT, goldenPath)}\n` +
            'Run: node tools/captured-fixtures/generate-pill-goldens.js --write'
          );
        }
        const expected = fs.readFileSync(goldenPath, 'utf8');
        const result = captureRun(sourceDir);
        result.errors.should.deepEqual({}, 'unexpected plugin errors during capture: ' + JSON.stringify(result.errors));
        const actual = stableStringify(result);
        if (actual !== expected) {
          // Fail with a hint for how to refresh; keep diff short.
          const aLines = actual.split('\n');
          const eLines = expected.split('\n');
          const max = Math.min(aLines.length, eLines.length, 200);
          let firstDiff = -1;
          for (let i = 0; i < max; i++) {
            if (aLines[i] !== eLines[i]) { firstDiff = i; break; }
          }
          const ctxBefore = Math.max(0, firstDiff - 3);
          const ctxAfter = Math.min(max, firstDiff + 6);
          const slice = (arr) => arr.slice(ctxBefore, ctxAfter).map((l, i) => `  ${ctxBefore + i + 1}: ${l}`).join('\n');
          throw new Error(
            `Golden drift in ${sourceName} starting line ${firstDiff + 1}.\n` +
            'Expected:\n' + slice(eLines) + '\n' +
            'Actual:\n' + slice(aLines) + '\n' +
            'If intentional: node tools/captured-fixtures/generate-pill-goldens.js --write'
          );
        }
        actual.should.equal(expected);
      });
    });
  }
});
