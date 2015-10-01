
var dir = __dirname;
var fs = require('fs');

function text ( ) {
  return sync(dir + '/example.txt').toString( );
}

function json ( ) {
  return JSON.parse(sync(dir + '/example.json'));
}

function source (src) {
  return source[src]( );
}
source.text = text;
source.json = json;

function sync (src) {
  return fs.readFileSync(src);
}
module.exports = source;
module.exports.sync = sync;
