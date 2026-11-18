'use strict';

const assert = require('node:assert/strict');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');

describe('report progress bar', function () {
  let env, state, progressBar;
  beforeEach(function () {
    env = createSecureDOM('<div id="info"><b>Loading ...</b></div>');
    state = globals.installDomGlobals(env);
    progressBar = require('../lib/report/progress-bar');
  });
  afterEach(function () {
    delete env.window.$.fn.progressbar;
    globals.restoreDomGlobals(state);
  });

  const bar = () => env.document.querySelectorAll('#info #report-progressbar');

  it('adds an accessible bar below the loading message', function () {
    progressBar.create(env.window.$('#info'));
    assert.equal(bar().length, 1);
    const node = bar()[0];
    assert.equal(node.getAttribute('role'), 'progressbar');
    assert.equal(node.getAttribute('aria-valuemin'), '0');
    assert.equal(node.getAttribute('aria-valuemax'), '100');
    assert.equal(node.getAttribute('aria-valuenow'), '0');
    assert.equal(env.document.querySelector('#info').firstChild.tagName, 'B', 'the message stays first');
  });

  it('shows progress as a width and as aria-valuenow', function () {
    progressBar.create(env.window.$('#info'));
    progressBar.update(40);
    assert.equal(bar()[0].getAttribute('aria-valuenow'), '40');
    assert.equal(bar()[0].querySelector('.report-progress-value').style.width, '40%');
    progressBar.update(100);
    assert.equal(bar()[0].querySelector('.report-progress-value').style.width, '100%');
  });

  it('keeps a single bar when the report is shown again', function () {
    progressBar.create(env.window.$('#info'));
    env.window.$('#info').html('<b>Loading ...</b>');
    progressBar.create(env.window.$('#info'));
    assert.equal(bar().length, 1);
    assert.equal(bar()[0].getAttribute('aria-valuenow'), '0');
  });

  it('uses the jQuery UI progressbar widget when it is loaded', function () {
    const calls = [];
    env.window.$.fn.progressbar = function (options) { calls.push(options); return this; };
    progressBar.create(env.window.$('#info'));
    progressBar.update(60);
    assert.deepEqual(calls, [{value: 0}, {value: 60}]);
    assert.equal(bar()[0].querySelector('.report-progress-value'), null, 'the widget draws its own markup');
  });
});
