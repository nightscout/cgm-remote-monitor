'use strict';

const should = require('should')
  , renderer = require('../lib/api3/shared/renderer')
  , xml2js = require('xml2js')
  ;

describe('API3 XML renderer hardening', function () {
  function renderXml (data) {
    let output;
    const res = {
      format: function (formats) {
        formats.xml();
      },
      send: function (value) {
        output = value;
      }
    };

    renderer.render(res, data);
    return output;
  }

  it('serializes underscore-prefixed document keys as elements, not attributes', function () {
    const output = renderXml({
      _metadata: 'untrusted metadata',
      note: 'plain text'
    });

    should(output).be.String();
    output.should.containEql('<_metadata>untrusted metadata</_metadata>');
    output.should.not.containEql(' metadata="untrusted metadata"');
  });

  it('encodes unsafe nested element names and produces well-formed XML', async function () {
    const unsafeKey = 'field><unexpected>extra</unexpected><field/'
      , output = renderXml({
        outer: [{
          [unsafeKey]: '<markup remains text>'
        }]
      });

    output.should.not.containEql('<unexpected>');
    output.should.containEql('&lt;markup remains text&gt;');

    await xml2js.parseStringPromise(output);
  });

  it('preserves ordinary names when an encoded unsafe name would collide', async function () {
    const unsafeKey = 'unsafe:name'
      , encodedName = `_encoded_${Buffer.from(unsafeKey, 'utf8').toString('base64url')}`
      , output = renderXml({
        [unsafeKey]: 'unsafe-key value',
        [encodedName]: 'ordinary-key value'
      });

    output.should.containEql(`<${encodedName}>ordinary-key value</${encodedName}>`);
    output.should.containEql(`<${encodedName}_2>unsafe-key value</${encodedName}_2>`);
    await xml2js.parseStringPromise(output);
  });
});
