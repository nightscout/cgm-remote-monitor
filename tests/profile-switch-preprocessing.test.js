'use strict';

const assert = require('assert');
const moment = require('moment-timezone');
const createProfile = require('../lib/profilefunctions');

describe('Embedded profile switch schedules', function () {
  [0, 180].forEach(function (duration) {
    [false, true].forEach(function (preprocessed) {
      it('normalizes ' + (preprocessed ? 'preprocessed' : 'time-only') +
        ' schedules for a ' + (duration ? 'temporary' : 'permanent') + ' switch', function () {
        const profile = createProfile([{
          defaultProfile: 'Default',
          startDate: '2026-01-01T00:00:00Z',
          store: { Default: {
            timezone: 'Asia/Seoul',
            basal: [{ time: '00:00', value: 0.5 }],
            sens: [{ time: '00:00', value: 50 }],
            carbratio: [{ time: '00:00', value: 10 }]
          } }
        }], { moment });
        const embedded = {
          timezone: 'Asia/Seoul',
          basal: [['00:00', 0.55], ['04:00', 0.77], ['08:00', 0.87],
            ['10:00', 0.93], ['13:00', 0.97], ['17:00', 0.75], ['20:00', 0.61]]
            .map(([time, value]) => ({ time, value })),
          sens: [{ time: '00:00', value: 40 }, { time: '10:00', value: 35 }],
          carbratio: [{ time: '00:00', value: 8 }, { time: '10:00', value: 7 }]
        };
        if (preprocessed) {
          profile.preprocessProfileOnLoad(embedded);
        }
        const switchTime = Date.parse('2026-08-08T00:00:00Z'); // 09:00 KST
        const treatment = {
          eventType: 'Profile Switch', mills: switchTime, duration,
          profile: 'Changed', profileJson: JSON.stringify(embedded)
        };
        const originalJson = treatment.profileJson;
        profile.updateTreatments([treatment], [], []);

        const from = profile.parseInTimezone('2026-08-08');
        const to = from.clone().add(1, 'day');
        const samples = profile.getBasalRenderTimes(+from, +to, 5 * 60 * 1000);
        samples.forEach(function (time) {
          const active = time >= switchTime && (!duration || time < switchTime + duration * 60000);
          const hour = moment.tz(time, 'Asia/Seoul').hour();
          let expected = 0.5;
          if (active) {
            embedded.basal.forEach(function (entry) {
              if (hour >= Number(entry.time.slice(0, 2))) { expected = entry.value; }
            });
          }
          assert.strictEqual(profile.getTempBasal(time).totalbasal, expected,
            'basal at ' + moment.tz(time, 'Asia/Seoul').format());
        });

        const tenAM = +profile.parseInTimezone('2026-08-08T10:00:00');
        assert.strictEqual(profile.getSensitivity(tenAM), 35);
        assert.strictEqual(profile.getCarbRatio(tenAM), 7);
        assert.strictEqual(treatment.profileJson, originalJson);
      });
    });
  });
});
