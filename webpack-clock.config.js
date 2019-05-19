const path = require('path');
const webpack = require('webpack');
const sourceMapType = 'source-map';
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  context: path.resolve(__dirname, '.'),
  entry: {
    app: './bundle/bundle.clocks.source.js'
  },
  output: {
    path: path.resolve(__dirname, './tmp'),
    publicPath: '/',
    filename: 'js/bundle.clock.js',
    sourceMapFilename: 'js/bundle.clock.js.map',
  },
  devtool: sourceMapType,
  optimization: {
    minimizer: [
      new TerserPlugin( {
        cache: true,
        parallel: true,
        sourceMap: true, // Must be set to true if using source-maps in production
        terserOptions: {
          ie8: false,
          safari10: false
          // https://github.com/webpack-contrib/terser-webpack-plugin#terseroptions
        }
      } ),
    ],
  },
  module: {
    rules: [{
      test: /\.(jpe?g|png|gif)$/i,
      loader: 'file-loader',
      query: {
        name: '[name].[ext]',
        outputPath: 'images/'
        //the images will be emmited to public/assets/images/ folder
        //the images will be put in the DOM <style> tag as eg. background: url(assets/images/image.png);
      },
      exclude: /node_modules/
    }
    ]
  }
};