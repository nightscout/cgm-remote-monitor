'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {gzipSync} = require('node:zlib');
const playwright = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const candidate = path.join(__dirname, 'd3-report-pie-candidate.js');
const engine = process.env.NIGHTSCOUT_TEST_BROWSER || 'chromium';

(async () => {
  const browser = await playwright[engine].launch();
  try {
    const page = await browser.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {requests.push(route.request().url()); return route.abort();});
    await page.setContent('<div id="flot" style="width:600px;height:240px"></div><div id="d3"></div>');
    for (const entry of ['app', 'reports']) await page.addScriptTag({path: path.join(root,
      'node_modules/.cache/_ns_cache/public/js/bundle.' + entry + '.js')});
    await page.addScriptTag({path: candidate});
    const result = await page.evaluate(() => {
      const cases = [];
      for (const values of [[10, 47.6, 42.4], [0, 100, 0], [0, 0, 0]]) {
        const series = values.map((data, i) => ({data, label: ['Low <safe>', 'In range', 'High'][i], color: ['#f88', '#8f8', '#ff8'][i]}));
        let flot, d3, timing = {flot: [], d3: []};
        for (let run = 0; run < 7; run++) {
          const startFlot = performance.now();
          flot = $.plot('#flot', series.map(item => ({...item})), {series: {pie: {show: true}}});
          timing.flot.push(performance.now() - startFlot);
          const startD3 = performance.now();
          d3 = window.renderD3ReportPieCandidate(document.getElementById('d3'), series);
          timing.d3.push(performance.now() - startD3);
        }
        cases.push({values, d3, flot: flot.getData().map(series => ({label: series.label, percent: series.percent, data: series.data})),
          svgCount: document.querySelectorAll('#d3 svg').length, text: document.querySelector('#d3').textContent, timing});
        flot.shutdown();
      }
      const dialog = document.createElement('dialog');
      return {cases, features: {nativeDialog: typeof dialog.showModal, modelessDialog: typeof dialog.show,
        jquery: $.fn.jquery, ui: $.ui.version}, candidateScope: 'static distribution pie only; not the time/candle/fillbetween/report suite'};
    });
    for (const row of result.cases) {
      assert.equal(row.svgCount, 1);
      assert.ok(row.text.includes('Low <safe>'));
      assert.deepEqual(row.d3.map(arc => arc.value), row.values);
      const total = row.values.reduce((a, b) => a + b, 0);
      if (total) {
        assert.ok(Math.abs(row.d3.reduce((sum, arc) => sum + arc.endAngle - arc.startAngle, 0) - 2 * Math.PI) < 1e-10);
        for (let i = 0; i < row.values.length; i++) assert.ok(Math.abs(row.flot[i].percent - 100 * row.values[i] / total) < 1e-10);
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    const source = fs.readFileSync(candidate);
    console.log(JSON.stringify({engine, browser: browser.version(), node: process.version,
      baseline: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), ...result,
      sources: Object.fromEntries(['tools/audits/browser-report-widget-probe.cjs',
        'node_modules/.cache/_ns_cache/public/js/bundle.app.js', 'node_modules/.cache/_ns_cache/public/js/bundle.reports.js']
        .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
      candidateSource: {bytes: source.length, gzipBytes: gzipSync(source, {level: 9}).length,
        sha256: crypto.createHash('sha256').update(source).digest('hex')},
      note: 'Unminified standalone helper bytes, not an application bundle saving. Existing D3 is reused.'}, null, 2));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
