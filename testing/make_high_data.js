var fs = require('fs');

var data = "";
var END_TIME = Date.now();
var FIVE_MINS_IN_MS = 300000;
var TIME_PERIOD_HRS = 4;
var DATA_PER_HR = 12;
var START_BG = 100;
var DELTA = 3;
var currentBG = START_BG;
var currentTime = END_TIME - (TIME_PERIOD_HRS * DATA_PER_HR * FIVE_MINS_IN_MS);

for(var i = 0; i < TIME_PERIOD_HRS * DATA_PER_HR; i++) {
    currentBG += DELTA;
    currentTime += FIVE_MINS_IN_MS;
    data += "1," + currentBG + ",,,,,,,,," + new Date(currentTime).toString() + ",,,,\n";
}

fs.writeFile("../Dexcom.csv", data);