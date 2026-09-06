'use strict';

require('should');

const helper = require('./inithelper')();
const cloneDeep = require('../lib/utils/clone');
const cloneShallow = require('../lib/utils/cloneShallow');
const html = require('../lib/utils/html');

describe('utils', function ( ) {

  const ctx = helper.getctx();
  
  ctx.settings.alarmTimeagoUrgentMins = 30;
  ctx.settings.alarmTimeagoWarnMins = 15;

  var utils = require('../lib/utils')(ctx);

  it('exports clone helpers', function () {
    utils.cloneDeep.should.equal(cloneDeep);
    utils.cloneShallow.should.equal(cloneShallow);
  });

  it('format numbers', function () {
    utils.toFixed(5.499999999).should.equal('5.50');
  });

  it('format numbers short', function () {
    var undef;
    utils.toRoundedStr(3.345, 2).should.equal('3.35');
    utils.toRoundedStr(5.499999999, 0).should.equal('5');
    utils.toRoundedStr(5.499999999, 1).should.equal('5.5');
    utils.toRoundedStr(5.499999999, 3).should.equal('5.5');
    utils.toRoundedStr(123.45, -2).should.equal('100');
    utils.toRoundedStr(-0.001, 2).should.equal('0');
    utils.toRoundedStr(-2.47, 1).should.equal('-2.5');
    utils.toRoundedStr(-2.44, 1).should.equal('-2.4');

    utils.toRoundedStr(undef, 2).should.equal('0');
    utils.toRoundedStr(null, 2).should.equal('0');
    utils.toRoundedStr('text', 2).should.equal('0');
  });

  it('merge date and time', function () {
    var result = utils.mergeInputTime('22:35', '2015-07-14');
    result.hours().should.equal(22);
    result.minutes().should.equal(35);
    result.year().should.equal(2015);
    result.format('MMM').should.equal('Jul');
    result.date().should.equal(14);
  });

  it('cloneDeep clones nested arrays and objects without shared references', function () {
    var source = {
      profile: {
        basal: [{ time: '00:00', value: 0.1 }],
        targets: {
          low: 80,
          high: 120
        }
      },
      enabled: ['bgnow', 'iob']
    };

    var result = cloneDeep(source);

    result.should.deepEqual(source);
    result.should.not.equal(source);
    result.profile.should.not.equal(source.profile);
    result.profile.basal.should.not.equal(source.profile.basal);
    result.profile.basal[0].should.not.equal(source.profile.basal[0]);
    result.profile.targets.should.not.equal(source.profile.targets);
    result.enabled.should.not.equal(source.enabled);

    result.profile.basal[0].value = 0.2;
    result.profile.targets.low = 90;
    result.enabled.push('cob');

    source.profile.basal[0].value.should.equal(0.1);
    source.profile.targets.low.should.equal(80);
    source.enabled.should.deepEqual(['bgnow', 'iob']);
  });

  it('cloneDeep clones supported object containers', function () {
    var date = new Date('2026-01-02T03:04:05.000Z');
    var pattern = /nightscout/gi;
    var mapValue = { units: 'mg/dl' };
    var setValue = { plugin: 'profile' };
    var source = {
      date: date,
      pattern: pattern,
      map: new Map([['settings', mapValue]]),
      set: new Set([setValue])
    };

    var result = cloneDeep(source);
    var clonedSetValue = Array.from(result.set)[0];

    result.date.should.not.equal(date);
    result.date.getTime().should.equal(date.getTime());
    result.pattern.should.not.equal(pattern);
    result.pattern.source.should.equal(pattern.source);
    result.pattern.global.should.equal(pattern.global);
    result.pattern.ignoreCase.should.equal(pattern.ignoreCase);
    result.map.should.not.equal(source.map);
    result.map.get('settings').should.deepEqual(mapValue);
    result.map.get('settings').should.not.equal(mapValue);
    result.set.should.not.equal(source.set);
    clonedSetValue.should.deepEqual(setValue);
    clonedSetValue.should.not.equal(setValue);
  });

  it('cloneShallow clones only the top level', function () {
    var nested = { value: 1 };
    var list = [{ value: 2 }];
    var source = {
      nested: nested,
      list: list
    };

    var result = cloneShallow(source);
    var arrayResult = cloneShallow(list);

    result.should.deepEqual(source);
    result.should.not.equal(source);
    result.nested.should.equal(nested);
    result.list.should.equal(list);
    arrayResult.should.deepEqual(list);
    arrayResult.should.not.equal(list);
    arrayResult[0].should.equal(list[0]);
  });

  describe('HTML text helpers', function () {
    it('exports the helpers through utils', function () {
      utils.escapeHtml('"\'&<>').should.equal('&quot;&#39;&amp;&lt;&gt;');
      utils.toTextContent.should.equal(html.toTextContent);
      utils.textAsHtml.should.equal(html.textAsHtml);
    });

    it('converts nullish and numeric values to text', function () {
      html.toTextContent(null).should.equal('');
      html.toTextContent(undefined).should.equal('');
      html.toTextContent(5).should.equal('5');
      html.textAsHtml(null).should.equal('');
      html.textAsHtml(undefined).should.equal('');
      html.textAsHtml(5).should.equal('5');
    });

    it('decodes sanitizer-serialized text for text-only DOM APIs', function () {
      html.toTextContent('Fish &amp; Chips &lt; 70').should.equal('Fish & Chips < 70');
      html.toTextContent('<img src=x onerror="alert(1)">').should.equal('<img src=x onerror="alert(1)">');
    });

    it('decodes one layer before escaping for an HTML text-node context', function () {
      html.textAsHtml('Already &#60;tag&#62; & raw').should.equal('Already &lt;tag&gt; &amp; raw');
      html.textAsHtml('&amp;lt;script&amp;gt;').should.equal('&amp;lt;script&amp;gt;');
      html.textAsHtml('<script>alert(document.domain)</script>')
        .should.equal('&lt;script&gt;alert(document.domain)&lt;/script&gt;');
    });
  });

});
