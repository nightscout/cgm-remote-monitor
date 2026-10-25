'use strict';

// URL-authorized viewers need the same credential on each tool page.
module.exports = function preserveEditorToken (document, location) {
  var token = new URLSearchParams(location.search).get('token');
  if (!token) return;
  document.querySelectorAll('.editor-navigation a').forEach(function (link) {
    var destination = new URL(link.getAttribute('href'), location.href);
    destination.searchParams.set('token', token);
    link.setAttribute('href', destination.pathname + destination.search + destination.hash);
  });
};
