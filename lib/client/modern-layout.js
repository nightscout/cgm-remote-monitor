'use strict';

// Keep the existing controls and plugin nodes: event handlers, alarm state and
// permissions continue to be owned by the normal Nightscout client.
module.exports = function modernLayout (client, $, refreshChart) {
  // Toolbar tooltips are the native help tooltip (help-tooltips.js), which
  // already opens below its trigger and inside both viewport edges.

  var drawer = $('#drawer');
  if (drawer.length && !drawer.children('.modern-drawer-header').length) {
    var heading = $('<div class="modern-drawer-header"></div>');
    heading.append($('<h2 id="modern-settings-title"></h2>').text(client.translate('Settings')));
    heading.append($('<button type="button" class="modern-drawer-close">×</button>')
      .attr('aria-label', client.translate('Close'))
      .on('click', function () {
        client.browserUtils.closeLastOpenedDrawer();
        $('#drawerToggle').trigger('focus');
      }));
    drawer.prepend(heading).attr({role: 'region', 'aria-labelledby': 'modern-settings-title'});
    // Move the original actions, preserving their settings handlers and values.
    $('#settings-form').append($('#settings-form > .actions'));
  }

  var treatment = $('#treatmentDrawer');
  if (treatment.length && !treatment.children('.modern-drawer-header').length) {
    var treatmentHeading = $('<div class="modern-drawer-header"></div>');
    treatmentHeading.append($('<h2 id="modern-treatment-title"></h2>').text(client.translate('Care Portal')));
    treatmentHeading.append($('<button type="button" class="modern-drawer-close">×</button>')
      .attr('aria-label', client.translate('Close'))
      .on('click', function () {
        client.browserUtils.closeLastOpenedDrawer();
        $('#treatmentDrawerToggle').trigger('focus');
      }));
    treatment.prepend(treatmentHeading).attr({role: 'region', 'aria-labelledby': 'modern-treatment-title'});
    // Move the original button without replacing its event handler.
    $('#treatment-form').append($('<div class="modern-treatment-actions"></div>').append($('#treatment-submit')));
  }

  $('.focus-range li[role="button"], .bgButton').on('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $(this).trigger('click');
    }
  });

  var frame;
  function resized () {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = null;
      if (client.chart) refreshChart(false);
    });
  }

  // Plugin pills can change height without a window resize (new values,
  // translation, font loading, notification banners, or newly enabled plugins).
  if (window.ResizeObserver) {
    var observer = new window.ResizeObserver(resized);
    var chartContainer = document.getElementById('chartContainer');
    if (chartContainer) observer.observe(chartContainer);
  }

  // A range change is still handled by the existing click handler.
  var ranges = $('.focus-range li[data-hours]');
  function selectedRange () {
    ranges.each(function () {
      $(this).attr('aria-pressed', $(this).hasClass('selected') ? 'true' : 'false');
    });
  }
  $('.focus-range').on('click', selectedRange);
  selectedRange();
};
