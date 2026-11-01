'use strict';

// THEME has always supported browser overrides. Resolve the dashboard before
// the client binds plugins or events so a saved theme and server default can
// never produce different layouts and renderers. Template contents are inert:
// their duplicate IDs cannot be found by jQuery or the normal DOM selectors.
module.exports = function applyDashboardTheme (document, theme) {
  var modern = theme === 'modern';
  var html = document.documentElement;
  if (html.classList.contains('modern-ui') !== modern) {
    var alternate = document.getElementById('alternate-dashboard');
    if (alternate && alternate.content) {
      var chart = document.getElementById('chartContainer');
      // The classic chart lives outside #container.
      if (chart && !chart.closest('#container')) chart.parentNode.remove();
      var container = document.getElementById('container');
      if (container) container.remove();
      alternate.parentNode.insertBefore(alternate.content.cloneNode(true), alternate);
    }
  }
  html.classList.toggle('modern-ui', modern);
  var viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.setAttribute('content', modern ?
    'width=device-width, initial-scale=1, viewport-fit=cover' :
    'width=device-width, maximum-scale=1, initial-scale=0.9, user-scalable=0');
};
