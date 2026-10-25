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
