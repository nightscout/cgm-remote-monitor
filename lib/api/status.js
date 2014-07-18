
function configure (app, wares) {
  var express = require('express'),
      api = express.Router( )
  ;

  api.use(wares.extensions([
    'json', 'svg', 'csv', 'txt', 'png', 'html'
  ]));
  // Status badge/text/json
  api.get('/', function (req, res, next) {
      var status = {status: 'ok'};
      var badge = 'http://img.shields.io/badge/Nightscout-OK-green';
      return res.format({
        html: function ( ) {
          res.send("<h1>STATUS OK</h1>");
        },
        png: function ( ) {
          res.redirect(302, badge + '.png');
        },
        svg: function ( ) {
          res.redirect(302, badge + '.svg');
        },
        text: function ( ) {
          res.send("STATUS OK");
        },
        json: function ( ) {
          res.json(status);
        }
      });
  });

  return api;
}
module.exports = configure;
