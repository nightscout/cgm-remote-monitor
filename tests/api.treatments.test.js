'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();
var moment = require('moment-timezone');

describe('Treatment API', function ( ) {
  this.timeout(10000);
  var self = this;

  var api = require('../lib/api/');
  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  after(function () {
    // delete process.env.API_SECRET;
  });

  it('post single treatments', function (done) {

    self.ctx.treatments().remove({ }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send({eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              var sorted = _.sortBy(list, function (treatment) {
                return treatment.created_at;
              });
              sorted.length.should.equal(2);
              sorted[0].glucose.should.equal(100);
              should.not.exist(sorted[0].eventTime);
              sorted[0].insulin.should.equal(2);
              sorted[1].carbs.should.equal(30);

              done();
            });
          }
        });

    });
  });

  it('post a treatment array', function (done) {
    self.ctx.treatments().remove({ }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send([
          {eventType: 'BG Check', glucose: 100, preBolus: '0', glucoseType: 'Finger', units: 'mg/dl', notes: ''}
          , {eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'}
         ])
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              list.length.should.equal(3);
              should.not.exist(list[0].eventTime);
              should.not.exist(list[1].eventTime);

              done();
            });
          }
        });
    });
  });

  it('post a treatment array and dedupe', function (done) {
    // test if deduping works. Starting with 0.9.0 Nightscout always stores created_at in UTC format, so even if a timezone is supplied it should dedupe records that have same time, but UTC or TimeZone notation
    self.ctx.treatments().remove({ }, function ( ) {
      var now_utc= new Date() ; // current date and time 
      now_utc.setMilliseconds(0) ; // reset milliseconds, because the moment library seems to reset milliseconds with some timezone conversions
      now_utc=now_utc.toISOString(); // convert to UTC ISO string
      // try different timezones as input                                      UTC offset UTC DST offset
      var now_amsterdam = moment(now_utc).tz("Europe/Amsterdam").format() ; // +01:00      +02:00
      var now_stjohns = moment(now_utc).tz("America/St_Johns").format() ;   // -03:30      -02:30
      var now_kabul = moment(now_utc).tz("Asia/Kabul").format() ;           // +04:30      +04:30
      var now_apia = moment(now_utc).tz("Pacific/Apia").format() ;          // +13:00      +14:00
      var now_gmt12 = moment(now_utc).tz("Etc/GMT+12").format() ;           // -12:00      -12:00
      var now_honolulu = moment(now_utc).tz("Pacific/Honolulu").format() ;  // -10:00      -10:00
      var yesterday_amsterdam  = moment(now_utc).subtract(1, 'days').tz("Europe/Amsterdam").format() ;
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send([
          {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_utc}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_utc} // duplicate records must be deduped based on their created_at timestamp
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_amsterdam} // even if they are another timezone format
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_stjohns}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_kabul}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_apia}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_gmt12}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_honolulu}
          , {eventType: 'BG Check', glucose: 80, units: 'mg/dl', created_at: yesterday_amsterdam} // out of order should be sorted
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now_amsterdam}
          , {eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 101, glucoseType: 'Finger', units: 'mg/dl'} // NS uses current time if no created_at is sent
        ])
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
               // the treatment list should be always sorted (most recent created_at first)
              console.info('debug treatments:', list);
              if (list.length !== 4) {
                console.info('unexpected result length, treatments:', list);
              }
              list.length.should.equal(4);
              list[0].eventType.should.equal("Meal Bolus"); 
              list[0].carbs.should.equal(30); // there should be a 'Meals Bolus' records with only the carbs 15 minutes before
              list[1].eventType.should.equal("Meal Bolus"); // 
              list[1].glucose.should.equal(101);
              list[1].preBolus.should.equal(15);
              list[1].insulin.should.equal(2);
              list[2].eventType.should.equal("BG Check"); // only one BG Check record on current time is returned
              list[2].glucose.should.equal(100);
              list[3].eventType.should.equal("BG Check"); // yesterday_amsterdam record
              list[3].glucose.should.equal(80);
              done();
            });
          }
        });
    });
  });
});
