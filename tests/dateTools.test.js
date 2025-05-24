/* eslint require-atomic-updates: 0 */
/* global should */
'use strict';

require('should');

describe('dateTools', function() {
  const dateTools = require('../lib/api3/shared/dateTools');
  const apiConst = require('../lib/api3/const.json');

  describe('floorSeconds', function() {
    it('should floor milliseconds to whole seconds', function() {
      const date = new Date('2023-01-01T12:34:56.789Z');
      const result = dateTools.floorSeconds(date);

      result.should.be.instanceOf(Date);
      result.getMilliseconds().should.equal(0);
      result.getTime().should.equal(new Date('2023-01-01T12:34:56.000Z').getTime());
    });

    it('should not change dates already at whole seconds', function() {
      const date = new Date('2023-01-01T12:34:56.000Z');
      const result = dateTools.floorSeconds(date);

      result.getTime().should.equal(date.getTime());
    });
  });

  describe('parseToDayjs', function() {

    describe('null and undefined handling', function() {
      it('should return null for null input', function() {
        const result = dateTools.parseToDayjs(null);
        (result === null).should.be.true();
      });

      it('should return null for undefined input', function() {
        const result = dateTools.parseToDayjs(undefined);
        (result === null).should.be.true();
      });

      it('should return null for empty string', function() {
        const result = dateTools.parseToDayjs('');
        (result === null).should.be.true();
      });
    });

    describe('array handling', function() {
      it('should parse first valid date from array', function() {
        const result = dateTools.parseToDayjs(['invalid', '2023-01-01T00:00:00Z', '2023-01-02T00:00:00Z']);

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(0); // 0-based
        result.date().should.equal(1);
      });

      it('should return null if no valid dates in array', function() {
        const result = dateTools.parseToDayjs(['invalid', 'also-invalid', 'not-a-date']);
        (result === null).should.be.true();
      });

      it('should handle empty array', function() {
        const result = dateTools.parseToDayjs([]);
        (result === null).should.be.true();
      });
    });

    describe('numeric timestamp handling', function() {
      it('should parse valid millisecond timestamp', function() {
        const timestamp = 1672531200000; // 2023-01-01T00:00:00.000Z
        const result = dateTools.parseToDayjs(timestamp);

        result.should.not.be.null();
        result.valueOf().should.equal(timestamp);
      });

      it('should parse valid second timestamp (unix time)', function() {
        const unixTimestamp = 1672531200; // 2023-01-01T00:00:00.000Z in seconds
        const result = dateTools.parseToDayjs(unixTimestamp);

        result.should.not.be.null();
        result.valueOf().should.equal(unixTimestamp * 1000);
      });

      it('should parse numeric string as timestamp', function() {
        const timestamp = '1672531200000';
        const result = dateTools.parseToDayjs(timestamp);

        result.should.not.be.null();
        result.valueOf().should.equal(parseInt(timestamp));
      });

      it('should reject timestamps before MIN_TIMESTAMP', function() {
        const result = dateTools.parseToDayjs(apiConst.MIN_TIMESTAMP - 1000);
        (result === null).should.be.true();
      });

      it('should reject negative timestamps', function() {
        const result = dateTools.parseToDayjs(-1);
        (result === null).should.be.true();
      });
    });

    describe('ISO 8601 date string parsing', function() {
      it('should parse basic ISO 8601 format', function() {
        const result = dateTools.parseToDayjs('2023-01-01T12:34:56Z');

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(0); // 0-based
        result.date().should.equal(1);
        result.hour().should.equal(12);
        result.minute().should.equal(34);
        result.second().should.equal(56);
      });

      it('should parse ISO 8601 with milliseconds', function() {
        const result = dateTools.parseToDayjs('2023-01-01T12:34:56.789Z');

        result.should.not.be.null();
        result.millisecond().should.equal(789);
      });

      it('should parse ISO 8601 with timezone offset', function() {
        const result = dateTools.parseToDayjs('2023-01-01T12:34:56+05:00');

        result.should.not.be.null();
        result.utcOffset().should.equal(300); // +05:00 in minutes
      });

      it('should parse ISO 8601 with negative timezone offset', function() {
        const result = dateTools.parseToDayjs('2023-01-01T12:34:56-08:00');

        result.should.not.be.null();
        result.utcOffset().should.equal(-480); // -08:00 in minutes
      });

      it('should parse ISO 8601 with comma decimal separator', function() {
        const result = dateTools.parseToDayjs('2019-06-10T08:07:08,576+02:00');

        result.should.not.be.null();
        result.year().should.equal(2019);
        result.month().should.equal(5); // 0-based (June)
        result.date().should.equal(10);
        result.hour().should.equal(8);
        result.minute().should.equal(7);
        result.second().should.equal(8);
        result.millisecond().should.equal(576);
        result.utcOffset().should.equal(120); // +02:00 in minutes
      });

      it('should parse date without time component', function() {
        const result = dateTools.parseToDayjs('2023-01-01');

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(0);
        result.date().should.equal(1);
      });
    });
    describe('RFC 2822 date string parsing', function() {
      it('should parse RFC 2822 format', function() {
        const result = dateTools.parseToDayjs('Mon, 01 Jan 2023 12:34:56 +0000');

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(0);
        result.date().should.equal(1);
        result.hour().should.equal(12);
        result.minute().should.equal(34);
        result.second().should.equal(56);
      });

      it('should parse RFC 2822 with timezone', function() {
        const result = dateTools.parseToDayjs('Wed, 15 Jun 2023 14:30:00 -0500');

        result.should.not.be.null();
        result.utcOffset().should.equal(-300); // -05:00 in minutes
      });
    });

    describe('other date formats', function() {
      it('should parse SQL datetime format', function() {
        const result = dateTools.parseToDayjs('2023-01-01 12:34:56');

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(0);
        result.date().should.equal(1);
        result.hour().should.equal(12);
        result.minute().should.equal(34);
        result.second().should.equal(56);
      });
    });

    describe('invalid date rejection - strict validation', function() {
      it('should reject impossible date components - month > 12', function() {
        const result = dateTools.parseToDayjs('2019-13-01T12:00:00');
        (result === null).should.be.true();
      });

      it('should reject impossible date components - day > 31', function() {
        const result = dateTools.parseToDayjs('2019-12-32T12:00:00');
        (result === null).should.be.true();
      });

      it('should reject impossible time components - hour > 23', function() {
        const result = dateTools.parseToDayjs('2019-12-31T25:00:00');
        (result === null).should.be.true();
      });

      it('should reject impossible time components - minute > 59', function() {
        const result = dateTools.parseToDayjs('2019-12-31T12:60:00');
        (result === null).should.be.true();
      });

      it('should reject impossible time components - second > 59', function() {
        const result = dateTools.parseToDayjs('2019-12-31T12:00:60');
        (result === null).should.be.true();
      });

      it('should reject the specific failing test case', function() {
        const result = dateTools.parseToDayjs('2019-20-60T50:90:90');
        (result === null).should.be.true();
      });

      it('should reject multiple invalid components', function() {
        const result = dateTools.parseToDayjs('2019-25-45T30:75:80');
        (result === null).should.be.true();
      });

      it('should reject month 0', function() {
        const result = dateTools.parseToDayjs('2019-00-01T12:00:00');
        (result === null).should.be.true();
      });

      it('should reject day 0', function() {
        const result = dateTools.parseToDayjs('2019-01-00T12:00:00');
        (result === null).should.be.true();
      });

      it('should reject completely invalid string', function() {
        const result = dateTools.parseToDayjs('not-a-date-at-all');
        (result === null).should.be.true();
      });

      it('should reject ABC string', function() {
        const result = dateTools.parseToDayjs('ABC');
        (result === null).should.be.true();
      });
    });

    describe('edge cases and boundary conditions', function() {
      it('should handle leap year date', function() {
        const result = dateTools.parseToDayjs('2020-02-29T12:00:00');

        result.should.not.be.null();
        result.year().should.equal(2020);
        result.month().should.equal(1); // February (0-based)
        result.date().should.equal(29);
      });

      it('should reject Feb 29 on non-leap year', function() {
        const result = dateTools.parseToDayjs('2021-02-29T12:00:00');
        (result === null).should.be.true();
      });

      it('should handle end of year', function() {
        const result = dateTools.parseToDayjs('2023-12-31T23:59:59');

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(11); // December (0-based)
        result.date().should.equal(31);
        result.hour().should.equal(23);
        result.minute().should.equal(59);
        result.second().should.equal(59);
      });

      it('should handle start of year', function() {
        const result = dateTools.parseToDayjs('2023-01-01T00:00:00');

        result.should.not.be.null();
        result.year().should.equal(2023);
        result.month().should.equal(0); // January (0-based)
        result.date().should.equal(1);
        result.hour().should.equal(0);
        result.minute().should.equal(0);
        result.second().should.equal(0);
      });

      it('should handle minimum timestamp boundary', function() {
        const result = dateTools.parseToDayjs(apiConst.MIN_TIMESTAMP);

        result.should.not.be.null();
        result.valueOf().should.equal(apiConst.MIN_TIMESTAMP);
      });
    });

    describe('timezone handling', function() {
      it('should preserve timezone information', function() {
        const result = dateTools.parseToDayjs('2023-06-15T10:30:00+02:00');

        result.should.not.be.null();
        result.utcOffset().should.equal(120); // +02:00 in minutes
      });

      it('should handle UTC timezone', function() {
        const result = dateTools.parseToDayjs('2023-06-15T10:30:00Z');

        result.should.not.be.null();
        result.utcOffset().should.equal(0); // UTC
      });

      it('should handle various timezone offsets', function() {
        const testCases = [
          { input: '2023-01-01T12:00:00+01:00', expected: 60 },
          { input: '2023-01-01T12:00:00-05:00', expected: -300 },
          { input: '2023-01-01T12:00:00+09:30', expected: 570 },
          { input: '2023-01-01T12:00:00-11:00', expected: -660 }
        ];

        testCases.forEach(({ input, expected }) => {
          const result = dateTools.parseToDayjs(input);
          result.should.not.be.null();
          result.utcOffset().should.equal(expected);
        });
      });
    });

    describe('performance and consistency', function() {
      it('should consistently parse the same date string', function() {
        const dateString = '2023-06-15T14:30:45.123Z';
        const result1 = dateTools.parseToDayjs(dateString);
        const result2 = dateTools.parseToDayjs(dateString);

        result1.should.not.be.null();
        result2.should.not.be.null();
        result1.valueOf().should.equal(result2.valueOf());
      });

      it('should handle multiple parse attempts efficiently', function() {
        const dateStrings = [
          '2023-01-01T00:00:00Z',
          '2023-06-15T12:30:45+02:00',
          '2023-12-31T23:59:59-08:00'
        ];

        dateStrings.forEach(dateString => {
          const result = dateTools.parseToDayjs(dateString);
          result.should.not.be.null();
        });
      });
    });

    describe('moment.js compatibility verification', function() {
      it('should maintain same behavior as moment.js for valid dates', function() {
        const validDates = [
          '2023-01-01T12:00:00Z',
          '2023-06-15T14:30:45.123+02:00',
          'Mon, 01 Jan 2023 00:00:00 +0000',
          '2023-12-31 23:59:59'
        ];

        validDates.forEach(dateString => {
          const result = dateTools.parseToDayjs(dateString);
          result.should.not.be.null();
          result.isValid().should.be.true();
        });
      });

      it('should maintain same strict rejection as moment.js for invalid dates', function() {
        const invalidDates = [
          '2019-20-60T50:90:90',
          '2019-13-01T12:00:00',
          '2019-12-32T12:00:00',
          '2019-12-31T25:00:00',
          '2019-12-31T12:60:00',
          '2019-12-31T12:00:60'
        ];

        invalidDates.forEach(dateString => {
          const result = dateTools.parseToDayjs(dateString);
          (result === null).should.be.true();
        });
      });
    });
  });
});
