const path = require('path');
const webpack = require('webpack');
const pluginArray = [];
const sourceMapType = 'source-map';
const MomentTimezoneDataPlugin = require('moment-timezone-data-webpack-plugin');
const projectRoot = path.resolve(__dirname, '..');

/*
if (process.env.NODE_ENV === 'development') {
  console.log('Development environment detected, enabling Bundle Analyzer');
  const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

  pluginArray.push(new BundleAnalyzerPlugin({
    // Can be `server`, `static` or `disabled`.
    // In `server` mode analyzer will start HTTP server to show bundle report.
    // In `static` mode single HTML file with bundle report will be generated.
    // In `disabled` mode you can use this plugin to just generate Webpack Stats JSON file by setting
    // `generateStatsFile` to `true`.
    analyzerMode: 'static',
    // Host that will be used in `server` mode to start HTTP server.
    analyzerHost: '127.0.0.1',
    // Port that will be used in `server` mode to start HTTP server.
    analyzerPort: 8888,
    // Path to bundle report file that will be generated in `static` mode.
    // Relative to bundles output directory.
    reportFilename: 'bundle_report.html',
    // Module sizes to show in report by default.
    // Should be one of `stat`, `parsed` or `gzip`.
    // See "Definitions" section for more information.
    defaultSizes: 'parsed',
    // Automatically open report in default browser
    openAnalyzer: true,
    // If `true`, Webpack Stats JSON file will be generated in bundles output directory
    generateStatsFile: false,
    // Name of Webpack Stats JSON file that will be generated if `generateStatsFile` is `true`.
    // Relative to bundles output directory.
    statsFilename: 'stats.json',
    // Options for `stats.toJson()` method.
    // For example you can exclude sources of your modules from stats file with `source: false` option.
    // See more options here: https://github.com/webpack/webpack/blob/webpack-1/lib/Stats.js#L21
    statsOptions: null,
    // Log level. Can be 'info', 'warn', 'error' or 'silent'.
    logLevel: 'info'
  }));
}
*/

pluginArray.push(new webpack.ProvidePlugin({
  $: 'jquery',
  jQuery: 'jquery',
  'window.jQuery': 'jquery',
  'window.$': 'jquery'
}));

pluginArray.push(new webpack.ProvidePlugin({
  process: 'process/browser',
}));

// limit Timezone data from Moment

pluginArray.push(new MomentTimezoneDataPlugin({
  startYear: 2015,
  endYear: 2035,
}));

if (process.env.NODE_ENV === 'development') {
  const ESLintPlugin = require('eslint-webpack-plugin');
  pluginArray.push(new ESLintPlugin({
    emitWarning: true,
    failOnError: false,
    failOnWarning: false,
    formatter: require('eslint').CLIEngine.getFormatter('stylish'),
    overrideConfig: {
      globals: {
        '$': 'writeable'
      }
    }
  }));
}

const rules = [
  {
    test: /\.(js|jsx)$/,
    use: {
      loader: 'babel-loader',
      options: {
        babelrc: true,
        cacheDirectory: true,
        extends: path.join(projectRoot, '/.babelrc')
      }
    }
  },
  {
    test: /\.css$/i,
    use: [ 'style-loader',
      {
        loader: 'css-loader',
        options: {
          sourceMap: true,
        },
      } ],
    exclude: /node_modules/
  },
  {
    test: /\.(jpe?g|png|gif)$/i,
    loader: 'file-loader',
    options: {
      outputPath: 'images'
      //the images will be emitted to public/assets/images/ folder
      //the images will be put in the DOM <style> tag as eg. background: url(assets/images/image.png);
    },
    exclude: /node_modules/
  },
  {
    test: require.resolve('jquery'),
    loader: 'expose-loader',
    options: {
      exposes: ['$']
    }
  }
];

const appEntry = ['./bundle/bundle.source.js'];
const clockEntry = ['./bundle/bundle.clocks.source.js'];

let mode = 'production';
let publicPath = '/bundle/';

if (process.env.NODE_ENV === 'development') {
  mode = 'development';
  publicPath = '/devbundle/';
  pluginArray.push(new webpack.HotModuleReplacementPlugin());
  pluginArray.push(new webpack.NoEmitOnErrorsPlugin());

  const hot = 'webpack-hot-middleware/client?port=1337';

  appEntry.unshift(hot);
  clockEntry.unshift(hot);
}

const optimization = {};


module.exports = {
  mode,
  context: projectRoot,
  entry: {
    app: appEntry,
    clock: clockEntry
  },
  output: {
    path: path.resolve(projectRoot, './node_modules/.cache/_ns_cache/public'),
    publicPath,
    filename: 'js/bundle.[name].js',
    sourceMapFilename: 'js/bundle.[name].js.map',
  },
  devtool: sourceMapType,
  optimization,
  plugins: pluginArray,
  module: {
    rules
  },
  resolve: {
    fallback: {
      'process/browser': require.resolve('process/browser'),
      events: require.resolve('events/')
    },
    alias: {
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      buffer: 'buffer',
    }
  }
};
