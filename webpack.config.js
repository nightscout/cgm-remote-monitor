const path = require('path');
const webpack = require('webpack');
const MomentLocalesPlugin = require('moment-locales-webpack-plugin');
const pluginArray = [];
const sourceMapType = 'source-map';
const TerserPlugin = require('terser-webpack-plugin');
const MomentTimezoneDataPlugin = require('moment-timezone-data-webpack-plugin');

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

// limit Timezone data from Moment

pluginArray.push(new MomentTimezoneDataPlugin({
  startYear: 2010,
  endYear: new Date().getFullYear() + 10,
}));

// Strip all locales except the ones defined in lib/language.js
// (“en” is built into Moment and can’t be removed, 'dk' is not defined in moment)
pluginArray.push(new MomentLocalesPlugin({
  localesToKeep: ['bg', 'cs', 'de', 'el', 'es', 'fi', 'fr', 'he', 'hr', 'it', 'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru',
    'sk', 'sv', 'zh_cn', 'zh_tw'
  ],
}));

const rules = [{
    test: /\.(jpe?g|png|gif)$/i,
    loader: 'file-loader',
    query: {
      name: '[name].[ext]',
      outputPath: 'images/'
      //the images will be emmited to public/assets/images/ folder
      //the images will be put in the DOM <style> tag as eg. background: url(assets/images/image.png);
    },
    exclude: /node_modules/
  },
  {
    test: /\.css$/,
    loaders: ['style-loader', 'css-loader'],
    exclude: /node_modules/
  },
  {
    test: require.resolve('jquery'),
    use: [{
      loader: 'expose-loader',
      options: '$'
    }]
  }
];

const appEntry = ['./bundle/bundle.source.js'];
const clockEntry = ['./bundle/bundle.clocks.source.js'];
const reportEntry = ['./bundle/bundle.reports.source.js'];

let mode = 'production';
let publicPath = '/bundle/';

if (process.env.NODE_ENV == 'development') {
  mode = 'development';
  publicPath = '/devbundle/';
  pluginArray.push(new webpack.HotModuleReplacementPlugin());
  pluginArray.push(new webpack.NoEmitOnErrorsPlugin());

  const hot = 'webpack-hot-middleware/client?port=1337';

  appEntry.unshift(hot);
  clockEntry.unshift(hot);
  reportEntry.unshift(hot);

  rules.unshift({
    enforce: "pre",
    test: /\.js$/,
    exclude: [/node_modules/, /bundle/],
    loader: "eslint-loader",
    options: {
      emitWarning: true,
      failOnError: false,
      failOnWarning: false,
      formatter: require('eslint/lib/cli-engine/formatters/stylish')
    }
  });

}

const optimization = {};

if (process.env.NODE_ENV !== 'development') {
  optimization.minimizer = [
    new TerserPlugin({
      cache: true,
      parallel: true,
      sourceMap: true, // Must be set to true if using source-maps in production
      terserOptions: {
        ie8: false,
        safari10: false
        // https://github.com/webpack-contrib/terser-webpack-plugin#terseroptions
      }
    }),
  ];
};

module.exports = {
  mode,
  context: __dirname,
  context: path.resolve(__dirname, '.'),
  entry: {
    app: appEntry,
    clock: clockEntry,
    report: reportEntry
  },
  output: {
    path: path.resolve(__dirname, './tmp'),
    publicPath,
    filename: 'js/bundle.[name].js',
    sourceMapFilename: 'js/bundle.[name].js.map',
  },
  devtool: sourceMapType,
  optimization,
  plugins: pluginArray,
  module: {
    rules
  }
};