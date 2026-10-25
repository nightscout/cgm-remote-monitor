'use strict';

// Keep the existing controls and plugin nodes: event handlers, alarm state and
// permissions continue to be owned by the normal Nightscout client.
module.exports = function modernLayout (client, $, refreshChart) {
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
