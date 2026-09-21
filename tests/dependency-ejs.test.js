'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const request = require('supertest');
const views = path.join(__dirname, '../views');

function renderFile(file, data) {
  return new Promise((resolve, reject) => {
    ejs.renderFile(path.join(views, file), data, {cache: true}, (error, html) => {
      if (error) reject(error);
      else resolve(html);
    });
  });
}

describe('EJS application template contracts', function () {
  afterEach(() => ejs.clearCache());

  for (const [file, type, entry] of [
    ['index.html', 'index', 'app'], ['reportindex.html', 'reports', 'reports'],
    ['adminindex.html', 'admin', 'admin'], ['profileindex.html', 'profile', 'profile'],
    ['foodindex.html', 'food', 'food']
  ]) {
    it(file + ' retains includes, escaped labels and fresh locals with cached templates', async function () {
      for (const revision of ['first & revision', 'second 💉 revision']) {
        const data = {type, title: 'Café <test> & "quotes"', bundle: '/bundle', cachebuster: revision};
        const html = await renderFile(file, data);
        assert.ok(html.includes('Café &lt;test&gt; &amp; &#34;quotes&#34;'));
        assert.ok(!html.includes('Café <test>'));
        assert.ok(html.includes('/bundle/js/bundle.' + entry + '.js?v=' + encodeURIComponent(revision)));
        assert.ok(html.includes('id="page-load-error"'));
        assert.ok(html.includes('id="page-load-retry"'));
        assert.ok(!html.includes('<%'));
      }
    });
  }

  it('escapes multiframe labels and attribute values', async function () {
    const html = await renderFile('frame.html', {settings: {
      frameUrl1: 'https://fixture.invalid/?a=1&b="quoted"', frameName1: '<b>Not markup</b>',
      frameUrl2: 'https://fixture.invalid/second', frameName2: 'Second 💉'
    }});
    assert.ok(html.includes('&lt;b&gt;Not markup&lt;/b&gt;'));
    assert.ok(html.includes('src="https://fixture.invalid/?a=1&amp;b=&#34;quoted&#34;"'));
    assert.ok(html.includes('Second 💉'));
    assert.equal((html.match(/<iframe /g) || []).length, 2);
  });

  it('renders actual clock routes and conditional CSS includes repeatedly', async function () {
    const app = require('../lib/server/clocks')();
    app.set('view cache', true);
    for (const revision of ['first build', 'second build']) {
      app.setLocals({bundle: '/bundle', cachebuster: revision});
      for (const face of ['clock-digital', 'config']) {
        const response = await request(app).get('/' + face).expect(200);
        assert.ok(response.text.includes('data-face="' + face + '"'));
        assert.ok(response.text.includes('/bundle/js/bundle.clock.js?v=' + encodeURIComponent(revision)));
        assert.equal(response.text.includes('data-face-config="cy10"'), face === 'config');
        assert.ok(!response.text.includes('<%'));
      }
    }
  });

  it('preserves formatted boot-error output through the actual Express view engine', async function () {
    const app = require('../lib/server/booterror')({}, {bootErrors: [{desc: 'Fixture failure', err: 'First\\nSecond'}]});
    const response = await request(app).get('/unavailable').expect(500);
    assert.ok(response.text.includes('<dt><b>Fixture failure</b></dt><dd>First<br/>Second</dd>'));
  });

  it('renders parseable service workers with the current build identity', function () {
    const source = fs.readFileSync(path.join(views, 'service-worker.js'), 'utf8');
    for (const cachebuster of ['first-build', 'second-build']) {
      const rendered = ejs.render(source, {locals: {cachebuster}});
      assert.ok(rendered.includes("var CACHE = '" + cachebuster + "';"));
      assert.doesNotThrow(() => new vm.Script(rendered));
    }
  });

  it('does not expose inherited locals to templates', function () {
    const data = Object.create({inheritedTemplateValue: 'unexpected'});
    data.ownedTemplateValue = 'expected';
    assert.equal(ejs.render('<%= typeof inheritedTemplateValue %>:<%= ownedTemplateValue %>', data), 'undefined:expected');
  });
});
