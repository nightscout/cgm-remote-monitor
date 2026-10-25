'use strict';

// Pins the stored text that lib/server/purifier.js produces for a fixed
// corpus of inputs, so that a sanitize-html or htmlparser2 upgrade that
// changes what Nightscout stores shows up as a test failure rather than as a
// silent change to user records.
//
// The inputs are plain notes and markup shapes already used publicly by
// tests/security.test.js and tests/browser/sanitizer-differential.test.js.
// Expected outputs are those of sanitize-html 2.18.1 with htmlparser2 12.

require('should');

const CORPUS = [
  // Plain notes: returned unchanged.
  ['plain note', 'Meal bolus', 'Meal bolus'],
  ['ampersand and less-than heart', 'Pizza & beer <3', 'Pizza & beer <3'],
  ['less-than in a glucose note', 'BG < 70, treated', 'BG < 70, treated'],
  ['letter after less-than opens a tag', 'a<b>c', 'a<b>c</b>'],
  ['comparison operators', 'x > y && y < z', 'x > y && y < z'],
  ['profile name with a tag-like suffix', 'Profile "Default" <basal>', 'Profile "Default" '],

  // Allowed formatting is kept.
  ['bold text', '<b>bold</b> note', '<b>bold</b> note'],
  ['paragraph and line break', '<p>para</p><br>line', '<p>para</p><br />line'],
  ['https link', '<a href="https://example.org/x">link</a>', '<a href="https://example.org/x">link</a>'],
  ['link with target and rel', '<a href="https://e.org" target="_blank" rel="noopener">t</a>', '<a href="https://e.org" target="_blank">t</a>'],
  ['table', '<table><tr><td>cell</td></tr></table>', '<table><tr><td>cell</td></tr></table>'],
  ['preformatted text with an entity', '<pre>code &amp; more</pre>', '<pre>code &amp; more</pre>'],
  ['heading and list', '<h1>Title</h1>\n<ul><li>one</li></ul>', '<h1>Title</h1>\n<ul><li>one</li></ul>'],
  ['unterminated bold is closed', '<b>unterminated', '<b>unterminated</b>'],
  ['inline style is removed', '<span style="color:red">red</span>', '<span>red</span>'],
  ['entities stay encoded', '&amp; &lt; &gt; &#0000060;script', '&amp; &lt; &gt; &#0000060;script'],

  // Unsafe URLs and event handlers are removed.
  ['javascript: link loses its href', '<a href="javascript:alert(1)">js</a>', '<a>js</a>'],
  ['image keeps https src, loses onerror', '<img src="https://example.org/i.png" onerror="alert(1)">', '<img src="https://example.org/i.png" />'],
  ['data: image src is removed', '<img src="data:image/png;base64,AAAA">', '<img />'],
  ['srcset keeps only the https candidate', '<img srcset="https://e.org/a.png 1x, javascript:alert(1) 2x">', '<img srcset="https://e.org/a.png 1x" />'],

  // Disallowed elements are discarded with their contents.
  ['script is discarded', '<script>alert(1)</script>safe', 'safe'],
  ['iframe is discarded', '<iframe src="https://example.org"></iframe>after', 'after'],
  ['iframe fallback markup is sanitized and kept', '<iframe><b>fallback</b></iframe>', '<b>fallback</b>'],
  ['nested unclosed iframes', '<iframe><iframe><iframe>deep', 'deep'],
  ['noscript with a closing tag inside an attribute', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', '<p></p>'],
  ['noscript closed by an enclosing end tag', '<div><noscript></div><img src="http://e.org/a.png"></noscript>', '<div></div><img src="http://e.org/a.png" />'],
  ['meta refresh to a javascript: URL', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', ''],
  ['textarea inside svg', '<svg><textarea><img src=x onerror=alert(1)></textarea></svg>', ''],
  ['svg animate retargeting href', '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', ''],
  ['svg link with an animate child', '<svg><a><animate attributeName="href" values="#safe;javascript:alert(\'XSS\')" dur=".01s" fill="freeze"></animate><text y="30">Click me</text></a></svg>', '<a>Click me</a>'],
  ['option and xmp', '<option>a</option><xmp><b></xmp>', ''],
  ['unclosed tag', '<unclosed', ''],
  ['HTML comment', '<!-- comment -->text', 'text'],
  ['XML processing instruction', '<?xml version="1.0"?>x', 'x'],

  // Changed in sanitize-html 2.17.6 (htmlparser2 12): an end tag with a
  // trailing solidus, `</textarea/>`, now closes the textarea as browsers do.
  // With sanitize-html 2.17.5 the parser kept everything after it inside the
  // discarded textarea, so the whole value was stored as ''. Now the
  // following image is parsed as an element: img is allowed, so its harmless
  // shell and src are kept, and the onerror handler is still removed.
  ['textarea closed by an end tag with a trailing solidus', '<textarea></textarea/><img src=x onerror=alert(1)>', '<img src="x" />'],
];

describe('purifier stored-text corpus', function() {
  const purifier = require('../lib/server/purifier')({}, {});

  it('has the expected corpus size', function() {
    CORPUS.length.should.equal(35);
  });

  CORPUS.forEach(function([label, input, expected]) {
    it('stores ' + label + ' as expected', function() {
      purifier.sanitizeString(input).should.equal(expected);
    });
  });

  it('stores the same text through purifyObject as through sanitizeString', function() {
    const record = {};
    CORPUS.forEach(function([, input], i) { record['field' + i] = input; });
    purifier.purifyObject(record);
    CORPUS.forEach(function([, , expected], i) {
      record['field' + i].should.equal(expected);
    });
  });

  it('never stores an event handler, a script URL or a disallowed element', function() {
    CORPUS.forEach(function([label, input]) {
      const out = purifier.sanitizeString(input);
      out.should.not.match(/\son[a-z]+\s*=/i, label);
      out.should.not.match(/javascript:/i, label);
      out.should.not.match(/<\s*(script|iframe|svg|math|meta|textarea|xmp|noscript|option|animate|style|object|embed)\b/i, label);
    });
  });
});
