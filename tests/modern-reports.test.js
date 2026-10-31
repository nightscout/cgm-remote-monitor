'use strict';

const assert = require('assert');
const {createSecureDOM} = require('./fixtures/secure-jsdom');
const globals = require('./fixtures/dom-globals');

describe('modern report navigation', function () {
  it('supports keyboard selection through existing handlers without resetting filters or duplicating listeners', function () {
    const env = createSecureDOM('<ul id="tabnav"><li id="daily" class="menutab selected">Daily</li><li id="stats" class="menutab">Stats</li></ul><fieldset id="report-filters"><legend>Report filters</legend><input id="rp_notes" value="Unchanged filter"><input type="date" id="rp_from" value="2026-10-01"><button id="rp_show">Show</button></fieldset><div id="daily-placeholder"></div><div id="stats-placeholder" style="display:none"></div>');
    const state = globals.installDomGlobals(env);
    try {
      const $ = env.window.$;
      let switches = 0;
      let shows = 0;
      $('#rp_show').on('click', () => { shows++; });
      const originalDate = $('#rp_from')[0];
      $('.menutab').on('click', function () {
        switches++;
        $('.menutab').removeClass('selected');
        $(this).addClass('selected');
        $('[id$="-placeholder"]').hide();
        $('#' + this.id + '-placeholder').show();
        return false;
      });
      const layout = require('../lib/report/modern-report-layout');
      layout($);
      layout($);
      assert.strictEqual($('.report-filter-panel').length, 1);
      assert.strictEqual($('.report-filter-panel').prop('open'), true);
      $('.report-filter-panel').prop('open', false).prop('open', true);
      assert.strictEqual($('#rp_from')[0], originalDate);
      $('#rp_show').trigger('click');
      assert.strictEqual(shows, 1);
      const event = $.Event('keydown', {key: 'Enter'});
      $('#stats').trigger(event);
      assert.ok(event.isDefaultPrevented());
      assert.strictEqual(switches, 1);
      assert.strictEqual($('#stats').attr('aria-pressed'), 'true');
      assert.strictEqual($('#daily').attr('aria-pressed'), 'false');
      assert.strictEqual($('#stats-placeholder')[0].style.display, '');
      assert.strictEqual($('#daily-placeholder')[0].style.display, 'none');
      $('#daily').trigger($.Event('keydown', {key: ' '}));
      assert.strictEqual(switches, 2);
      assert.strictEqual($('#daily').attr('aria-pressed'), 'true');
      assert.strictEqual($('#daily').attr('tabindex'), '0');
      assert.strictEqual($('#rp_notes').val(), 'Unchanged filter');
      assert.strictEqual($('#rp_from').val(), '2026-10-01');
      $('#stats').trigger($.Event('keydown', {key: 'ArrowDown'}));
      assert.strictEqual(switches, 2);
    } finally { globals.restoreDomGlobals(state); env.cleanup(); }
  });
});

describe('daily insulin and carbohydrate summaries', function () {
  let env, state, host;
  beforeEach(function () {
    env = createSecureDOM('<div id="daily-summary"></div>');
    state = globals.installDomGlobals(env);
    host = env.window.$('#daily-summary');
  });
  afterEach(function () {globals.restoreDomGlobals(state); env.cleanup();});
  function render(values) {
    require('../lib/report/daily-distribution')(host, values, text => text, require('../lib/d3.mjs'));
  }
  it('shows the actual insulin split and makes the carbs comparison explicit', function () {
    const values = {basal: 18, bolus: 12, carbs: 45, maxCarbs: 180};
    render(values);
    assert.strictEqual(host.find('.daily-insulin-total').text(), '30.0');
    assert.deepStrictEqual(host.find('.daily-insulin-name small').toArray().map(node => node.textContent), ['60.0%', '40.0%']);
    assert.deepStrictEqual(host.find('.daily-insulin-key strong').toArray().map(node => node.textContent), ['18.0 U', '12.0 U']);
    assert.strictEqual(new Set(host.find('.daily-insulin-ring path').toArray().map(node => node.getAttribute('fill'))).size, 2);
    assert.strictEqual(host.find('.daily-carbs-total').text(), '45 g');
    assert.strictEqual(host.find('.daily-carbs-track > span')[0].style.width, '25%');
    assert.strictEqual(host.find('.daily-carbs-comparison').text(), 'Highest selected day: 180 g');
    assert.ok(!host.text().includes('goal'));
    assert.deepStrictEqual(values, {basal: 18, bolus: 12, carbs: 45, maxCarbs: 180});
  });
  it('handles zero and single-category insulin without NaN percentages', function () {
    render({basal: 0, bolus: 0, carbs: 0, maxCarbs: 0});
    assert.strictEqual(host.find('.daily-insulin-total').text(), '0.0');
    assert.strictEqual(host.find('.daily-insulin-ring path').length, 0);
    assert.ok(host.text().includes('No insulin recorded'));
    assert.ok(host.text().includes('No carbs recorded'));
    assert.strictEqual(host.find('.daily-carbs-track').length, 0);
    render({basal: 0, bolus: 10, carbs: 0, maxCarbs: 100});
    assert.strictEqual(host.find('.daily-insulin-ring path').length, 1);
    assert.deepStrictEqual(host.find('.daily-insulin-name small').toArray().map(node => node.textContent), ['0.0%', '100.0%']);
    assert.ok(!host.html().includes('NaN'));
  });
  it('does not turn unavailable totals into a misleading zero or full ring', function () {
    render({basal: -2, bolus: 5, carbs: NaN, maxCarbs: 100});
    assert.strictEqual(host.find('.daily-insulin-total').text(), '—');
    assert.strictEqual(host.find('.daily-insulin-ring path').length, 0);
    assert.ok(host.text().includes('Insulin breakdown unavailable'));
    assert.strictEqual(host.find('.daily-carbs-total').text(), '— g');
    assert.strictEqual(host.find('.daily-carbs-track').length, 0);
    assert.ok(!host.html().includes('NaN'));
  });
});
