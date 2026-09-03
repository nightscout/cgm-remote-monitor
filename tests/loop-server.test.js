'use strict';

var apn = require('@parse/node-apn');

describe('server loop notifications', function () {
  var OriginalProvider = apn.Provider;
  var OriginalNotification = apn.Notification;

  afterEach(function () {
    apn.Provider = OriginalProvider;
    apn.Notification = OriginalNotification;
  });

  function makeProfile (isAPNSProduction) {
    var profile = {
      loopSettings: {
        deviceToken: 'test-device-token',
        bundleIdentifier: 'com.example.loop'
      }
    };

    if (isAPNSProduction !== undefined) {
      profile.isAPNSProduction = isAPNSProduction;
    }

    return profile;
  }

  function sendLoopNotification (profile, pushServerEnvironment) {
    return new Promise(function (resolve, reject) {
      var capturedOptions;
      apn.Provider = function MockProvider (options) {
        capturedOptions = options;
        this.send = function (notification, tokens) {
          return Promise.resolve({ sent: [{ device: tokens[0] }], failed: [] });
        };
      };
      apn.Notification = function MockNotification () { };

      var env = {
        extendedSettings: {
          loop: {
            apnsKey: 'test-key',
            apnsKeyId: 'test-key-id',
            developerTeamId: 'TEAMID1234',
            pushServerEnvironment: pushServerEnvironment
          }
        }
      };
      var ctx = {
        ddata: {
          profiles: [profile]
        }
      };
      var loop = require('../lib/server/loop')(env, ctx);

      loop.sendNotification({ eventType: 'Temporary Override Cancel' }, '127.0.0.1', function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(capturedOptions);
      });
    });
  }

  it('uses profile isAPNSProduction true over environment fallback', function () {
    return sendLoopNotification(makeProfile(true), 'sandbox').then(function (options) {
      options.production.should.equal(true);
    });
  });

  it('uses profile isAPNSProduction false over production environment fallback', function () {
    return sendLoopNotification(makeProfile(false), 'production').then(function (options) {
      options.production.should.equal(false);
    });
  });

  it('falls back to LOOP_PUSH_SERVER_ENVIRONMENT when profile field is absent', function () {
    return sendLoopNotification(makeProfile(), 'production').then(function (options) {
      options.production.should.equal(true);
    });
  });
});
