'use strict';

// Keep the existing controls and plugin nodes: event handlers, alarm state and
// permissions continue to be owned by the normal Nightscout client.
module.exports = function modernLayout (client, $, refreshChart) {
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
    observer.observe(document.getElementById('chartContainer'));
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
