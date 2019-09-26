'use strict';

const _ = require('lodash');
const apn = require('apn');

function init (env, ctx) {

  function loop () {
    return loop;
  }

  loop.sendNotification = function sendNotification (data, completionHandler) {
    console.info('loop notify: ', data);
    completionHandler();
  };

  // var pushNotificationToLoop = function () {
  //   // api.development.push.apple.com:443
  //   // api.push.apple.com:443
  //   var server = 'https://api.development.push.apple.com:443';
  //   var deviceToken = 'ee24b4e867cbf0f49af3cb0e45879075b7e6adae881ec21efe245941eb77f412';
  //   var bundleId = 'com.UY678SP37Q.loopkit.Loop';
  //
  //   const client = http2.connect(server);
  //   client.on('error', (err) => console.error(err));
  //   const req = client.request({ ':path': '/3/device/' + deviceToken, ':method': 'POST' });
  //   req.on('response', (headers, flags) => {
  //     for (const name in headers) {
  //       console.log(`${name}: ${headers[name]}`);
  //     }
  //   });
  //
  //   req.setEncoding('utf8');
  //   let data = '';
  //   req.on('data', (chunk) => { data += chunk; });
  //   req.on('end', () => {
  //     console.log(`\n${data}`);
  //     client.close();
  //   });
  //   req.end();
  // }


  return loop();
}

module.exports = init;
