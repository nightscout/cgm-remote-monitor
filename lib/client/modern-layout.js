'use strict';

// Keep the existing controls and plugin nodes: event handlers, alarm state and
// permissions continue to be owned by the normal Nightscout client.
module.exports = function modernLayout (client, $, refreshChart) {
  $('#buttonbar .tip').each(function () {
    var tooltip = $(this).data('tooltip');
    // Keep the existing hover handlers and the touch-screen tooltip policy.
    if (!tooltip) return;
    // The plugin shares its original options across the whole .tip collection.
    tooltip.options = $.extend({}, tooltip.options, {
      offset: 6,
      gravity: function () {
        var center = $(this).offset().left + this.offsetWidth / 2;
        var halfWidth = $(this).data('tooltip').tip()[0].offsetWidth / 2;
        var left = $(window).scrollLeft();
        if (center - halfWidth < left + 8) return 'nw';
        if (center + halfWidth > left + document.documentElement.clientWidth - 8) return 'ne';
        return 'n';
      }
    });
  });

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
