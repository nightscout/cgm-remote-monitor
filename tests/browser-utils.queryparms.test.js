'use strict';

/*
 * queryParms() is the first thing lib/client/index.js client.init calls.
 *
 * It split the query string on '&' and then read [1] of each segment's split
 * on '=', with no check that there was a [1]. A segment with no value - a
 * bare flag like `?debug`, a trailing `&`, an accidental `&&`, or a lone `?`
 * - produced `undefined.replace(...)` and threw, and the throw is on the
 * first line of client initialisation, so the page stopped loading there with
 * nothing on screen but the loading message.
 *
 * The suppression above it was for the useless `\+` escape inside a character
 * class. That was a correct reading of the question the linter asked, on a
 * line that had a different problem.
 */

require('should');

const browserUtils = require('../lib/client/browser-utils');

// A stub rather than jsdom: init() only needs $ to be callable and chainable,
// and $.fn.tooltip to be an object it can hang defaults on. Nothing in this
// test reaches the DOM.
function stubJquery ( ) {
  function chain ( ) {
    return {
      tooltip: chain, find: chain, click: chain, width: function ( ) { return 1024; }
      , addClass: chain, removeClass: chain, html: chain, css: chain, show: chain
    };
  }
  const $ = function ( ) { return chain(); };
  $.fn = { tooltip: { } };
  return $;
}

describe('browser-utils queryParms', function ( ) {
  let priorLocation, priorDocument, utils;

  beforeEach(function ( ) {
    priorLocation = Object.getOwnPropertyDescriptor(global, 'location');
    priorDocument = Object.getOwnPropertyDescriptor(global, 'document');
    // isTouch() asks document.createEvent('TouchEvent') and treats a throw as
    // "not a touch screen", which is the branch a stub naturally takes.
    Object.defineProperty(global, 'document', {
      configurable: true, writable: true,
      value: { createEvent: function ( ) { throw new Error('no TouchEvent'); } }
    });
    Object.defineProperty(global, 'location', {
      configurable: true, writable: true, value: { search: '' }
    });
    utils = browserUtils(stubJquery());
  });

  afterEach(function ( ) {
    if (priorLocation) { Object.defineProperty(global, 'location', priorLocation); } else { delete global.location; }
    if (priorDocument) { Object.defineProperty(global, 'document', priorDocument); } else { delete global.document; }
  });

  function parse (search) {
    global.location.search = search;
    return utils.queryParms();
  }

  it('parses a well-formed query exactly as before', function ( ) {
    parse('?token=abc').should.eql({ token: 'abc' });
    parse('?token=abc&units=mmol').should.eql({ token: 'abc', units: 'mmol' });
    parse('').should.eql({ });
  });

  it('keeps the underscore and plus substitution', function ( ) {
    parse('?name=a_b+c').should.eql({ name: 'a b c' });
  });

  it('does not throw on a valueless parameter', function ( ) {
    // Before the fix each of these threw
    // "Cannot read properties of undefined (reading 'replace')".
    parse('?debug').should.eql({ debug: '' });
    parse('?a=1&b').should.eql({ a: '1', b: '' });
  });

  it('does not throw on a trailing, doubled or lone ampersand', function ( ) {
    parse('?token=abc&').should.eql({ token: 'abc' });
    parse('?a=1&&b=2').should.eql({ a: '1', b: '2' });
    parse('?').should.eql({ });
  });

  it('reads a valueless parameter the way its callers already treat absence', function ( ) {
    // lib/client/index.js does `queryParms().token || clientToken` and
    // `queryParms().mute !== 'true'`; the empty string satisfies both.
    const parms = parse('?token&mute');
    (parms.token || 'fallback').should.equal('fallback');
    (parms.mute !== 'true').should.equal(true);
  });
});
