var fs = require('fs');
var times = require('../lib/times');

var data = '';
var END_TIME = Date.now();
var TIME_PERIOD_HRS = 24;
var DATA_PER_HR = 12;
var START_BG = 50;
var currentBG = START_BG;
var currentTime = END_TIME - (TIME_PERIOD_HRS * DATA_PER_HR * times.mins(5).msecs);

for(var i = 0; i < TIME_PERIOD_HRS * DATA_PER_HR; i++) {
  currentBG += Math.ceil(Math.cos(i)*5+.2);
  currentTime += times.mins(5).msecs;
  data += '1,' + currentBG + ',,,,,,,,,' + new Date(currentTime).toString() + ',,,,\n';
}
fs.writeFile('../Dexcom.csv', data);

function makedata() {
  currentBG -= 1;
  currentTime += times.mins(5).msecs;
  data += '1,' + currentBG + ',,,,,,,,,' + new Date(currentTime).toString() + ',,,,\n';
  fs.writeFile('../Dexcom.csv', data);
}

setInterval(makedata, 1000 * 10);