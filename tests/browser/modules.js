'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
let bundle;

// Compile once per test process, into a separate cache. Never rebuild or clean
// the production assets being exercised by the other browser suites.
exports.buildModules = function () {
  if (!bundle) bundle = (async () => {
    const webpack = require('webpack');
    const config = require('../../webpack/webpack.config');
    const output = path.resolve(__dirname, '../../node_modules/.cache/nightscout-browser-tests');
    const compiler = webpack({
      ...config,
      entry: {modules: path.resolve(__dirname, 'modules.source.js')},
      output: {...config.output, path: output, publicPath: '/', filename: 'modules.js', sourceMapFilename: 'modules.js.map'}
    });
    try {
      await new Promise((resolve, reject) => compiler.run((error, stats) => {
        if (error) reject(error);
        else if (stats.hasErrors()) reject(new Error(stats.toString({all: false, errors: true})));
        else resolve();
      }));
      return await fs.readFile(path.join(output, 'modules.js'));
    } finally {
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    }
  })();
  return bundle;
};
