'use strict';

exports.get_cgm_record = function() {
  var dateobj = new Date();
  var datemil = dateobj.getTime();
  var datesec = datemil / 1000;
  var datestr = dateobj.toISOString();

  // We put the time in a range from -1 to +1 for every thiry minute period
  var range = (datesec % 1800) / 900 - 1.0;

  // The we push through a COS function and scale between 40 and 400 (so it is like a bg level)
  var sgv = Math.floor(360 * (Math.cos(10.0 * range / 3.14) / 2 + 0.5)) + 40;
  var dir = range > 0.0 ? 'FortyFiveDown' : 'FortyFiveUp';

  console.log('Writing Record: ');
  console.log('sgv  = ' + sgv);
  console.log('date = ' + datemil);
  console.log('dir  = ' + dir);
  console.log('str  = ' + datestr);

  return {
    'device': 'dexcom',
    'date': datemil,
    'sgv': sgv,
    'direction': dir,
    'dateString': datestr
  };
};