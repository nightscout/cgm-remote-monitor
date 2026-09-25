'use strict';

// Filesystem paths are repository fixtures or files in a new temporary directory.
/* eslint-disable security/detect-non-literal-fs-filename */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const semver = require('semver');
const postcss = require('postcss');
const sanitizeHtml = require('sanitize-html');
const lock = require('../package-lock.json');

describe('PostCSS dependency regressions', function () {
  it('installs the reviewed release for CSS loading and HTML sanitization', function () {
    const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('/postcss'));
    assert.ok(copies.length > 0);
    copies.forEach(([name, entry]) => {
      // These module paths come only from the committed lockfile.
      // eslint-disable-next-line security/detect-non-literal-require
      const installed = require(path.resolve(__dirname, '..', name, 'package.json'));
      assert.strictEqual(installed.version, entry.version);
      assert.ok(semver.satisfies(installed.version, '>=8.5.28 <9'));
    });
    for (const consumer of ['css-loader', 'sanitize-html']) {
      const consumerRequire = createRequire(require.resolve(consumer));
      const installed = consumerRequire('postcss/package.json');
      // eslint-disable-next-line security/detect-non-literal-require
      const parent = require(consumer + '/package.json');
      assert.ok(semver.satisfies(installed.version, parent.dependencies.postcss));
      assert.strictEqual(consumerRequire('postcss'), postcss);
    }
  });

  const stylesheets = [
    'static/css/drawer.css',
    'static/css/dropdown.css',
    'static/css/sgv.css',
    'views/clockviews/clock-shared.css',
    'views/clockviews/clock-config.css'
  ];
  stylesheets.forEach(file => {
    it('preserves CSS and source-map content for ' + file, function () {
      const from = path.resolve(__dirname, '..', file);
      const css = fs.readFileSync(from, 'utf8');
      const result = postcss([{ postcssPlugin: 'round-trip', Once() {} }]).process(css, {
        from,
        map: { inline: false, annotation: false }
      });
      assert.strictEqual(result.css, css);
      assert.deepStrictEqual(result.map.toJSON().sourcesContent, [css]);
    });
  });

  it('preserves harmless hash-prefixed comments and a leading BOM', function () {
    const css = '\uFEFF/*# Nightscout theme */\n.widget { color: red }';
    const result = postcss([{ postcssPlugin: 'round-trip', Once() {} }])
      .process(css, { from: 'theme.css', map: false });
    assert.strictEqual(result.css, css);
    assert.strictEqual(postcss().process(css, { from: 'theme.css', map: false }).css, css);
  });

  it('keeps a custom property separate from an appended comment', function () {
    const root = postcss.parse('.widget{--accent:red}');
    root.first.append(postcss.comment({ text: 'theme' }));
    const parsed = postcss.parse(root.toString());
    assert.strictEqual(parsed.first.first.value, 'red');
    assert.deepStrictEqual(parsed.first.nodes.map(node => node.type), ['decl', 'comment']);
  });

  it('preserves empty comma-list items without inventing whitespace items', function () {
    assert.deepStrictEqual(postcss.list.comma('red,,blue,'), ['red', '', 'blue', '']);
    assert.deepStrictEqual(postcss.list.space(' \t\r\n '), []);
    assert.deepStrictEqual(postcss.list.comma('rgb(1, 2, 3), "a,b"'), ['rgb(1, 2, 3)', '"a,b"']);
  });

  it('visits inserted CSS rules consistently in sync and async processing', async function () {
    function plugin(order) {
      return {
        postcssPlugin: 'unwrap-nested',
        Rule(rule) {
          order.push(rule.selector);
          rule.each(child => {
            if (child.type === 'rule') {
              child.selector = rule.selector + ' ' + child.selector;
              rule.after(child);
            }
          });
        },
        RootExit() { order.push('exit'); }
      };
    }
    const syncOrder = [];
    const asyncOrder = [];
    const css = '.widget { .value { span {} } }';
    const options = { from: 'theme.css', map: false };
    const sync = postcss([plugin(syncOrder)]).process(css, options).css;
    const asyncResult = await postcss([plugin(asyncOrder)]).process(css, options);
    assert.strictEqual(asyncResult.css, sync);
    assert.deepStrictEqual(asyncOrder, syncOrder);
    const nestedVisit = syncOrder.indexOf('.widget .value span');
    assert.ok(nestedVisit >= 0 && nestedVisit < syncOrder.indexOf('exit'));
    assert.ok(sync.includes('.widget .value span'));
  });

  it('preserves formatting when a CSS AST is serialized and restored', function () {
    const css = '.one {}\n.two {}\n\n.three {}\n';
    const json = JSON.parse(JSON.stringify(postcss.parse(css).toJSON()));
    assert.strictEqual(postcss.fromJSON(json).toString(), css);
  });

  it('prevents serialized AST properties from replacing the node prototype', function () {
    const json = JSON.parse('{"type":"decl","prop":"color","value":"red","__proto__":{"hijacked":true}}');
    const node = postcss.fromJSON(json);
    assert.strictEqual(node.hijacked, undefined);
    assert.strictEqual(node.toString(), 'color: red');
  });

  it('preserves permitted inline styles through sanitize-html', function () {
    const result = sanitizeHtml('<p style="color: red; /* note */ font-weight: 700; position: fixed">note</p>', {
      allowedTags: ['p'],
      allowedAttributes: { p: ['style'] },
      allowedStyles: { '*': { color: [/^red$/], 'font-weight': [/^700$/] } }
    });
    assert.strictEqual(result, '<p style="color:red;font-weight:700">note</p>');
  });

  it('preserves Nightscout note text while stripping styles and active markup', function () {
    const purify = require('../lib/server/purifier')();
    const note = { notes: '<p style="color:red" onclick="alert(1)">BG &lt; 70</p><script>alert(1)</script>' };
    purify.purifyObject(note);
    assert.deepStrictEqual(note, { notes: '<p>BG &lt; 70</p>' });
    assert.strictEqual(purify.sanitizeString('Fish & Chips; BG < 70'), 'Fish & Chips; BG < 70');
  });

  describe('previous source-map boundaries', function () {
    let directory;
    let from;
    const sourceMap = JSON.stringify({
      version: 3, sources: ['theme.scss'], names: [], mappings: 'AAAA',
      sourcesContent: ['.widget { color: red }']
    });
    function input(annotation, options = { from }) {
      return postcss.parse('.widget { color: red }\n/*# sourceMappingURL=' + annotation + ' */', options).source.input;
    }
    before(function () {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-postcss-'));
      fs.mkdirSync(path.join(directory, 'css'));
      from = path.join(directory, 'css', 'theme.css');
      fs.writeFileSync(path.join(directory, 'css', 'theme.css.map'), sourceMap);
      fs.writeFileSync(path.join(directory, 'outside.map'), sourceMap);
    });
    after(function () {
      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('loads a source map beside the stylesheet', function () {
      assert.strictEqual(input('theme.css.map').map.text, sourceMap);
    });
    it('continues to accept inline and explicitly supplied maps', function () {
      const inline = 'data:application/json;base64,' + Buffer.from(sourceMap).toString('base64');
      assert.strictEqual(input(inline).map.text, sourceMap);
      assert.strictEqual(input('ignored.map', { from, map: { prev: sourceMap } }).map.text, sourceMap);
    });
    it('ignores annotations outside the stylesheet directory', function () {
      assert.strictEqual(input('../outside.map').map, undefined);
    });
    it('ignores file annotations when no source filename is provided', function () {
      assert.strictEqual(input(path.join(directory, 'outside.map'), {}).map, undefined);
    });
    it('does not follow a source-map symlink outside the stylesheet directory', function () {
      fs.symlinkSync(path.join(directory, 'outside.map'), path.join(directory, 'css', 'linked.map'), 'file');
      assert.strictEqual(input('linked.map').map, undefined);
    });
  });
});
