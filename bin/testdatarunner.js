
'use strict';

const axios = require('axios');
const moment = require('moment');
const crypto = require('crypto');
const shasum = crypto.createHash('sha1');

const FIVE_MINUTES = 1000 * 60 * 5;

if (process.argv.length < 4) {
    console.error('This is an utility to send continuous CGM entry data to a test Nightscout server')
    console.error('USAGE: node testdatarunner.js <SERVER BASE URL> <API_SECRET>');
    process.exit();
}

const URL = process.argv[2];
const SECRET = process.argv[3];
shasum.update(SECRET);
const SECRET_SHA1 = shasum.digest('hex');

const HEADERS = {'api-secret': SECRET_SHA1};

const ENTRIES_URL = URL + '/api/v1/entries';

var done = (function wait () { if (!done) setTimeout(wait, 1000); })();

console.log('NS data filler active');

const entry =   {
  device: 'Dev simulator',
  date: 1609061083612,
  dateString: '2020-12-27T09:24:43.612Z',
  sgv: 100,
  delta: 0,
  direction: 'Flat',
  type: 'sgv'
};

function addEntry () {
  console.log('Sending add new entry');
  sendEntry(Date.now());
  setTimeout(addEntry, FIVE_MINUTES);
}

function oscillator(time, frequency = 1, amplitude = 1, phase = 0, offset = 0){
  return Math.sin(time * frequency * Math.PI * 2 + phase * Math.PI * 2) * amplitude + offset; 
}

async function sendFail() {
  try {
    console.log('Sending fail');
    const response = await axios.post(ENTRIES_URL, entry, {headers: {'api-secret': 'incorrect' }});
  } catch (e) { }
}

async function sendEntry (date) {
  const m = moment(date);
  entry.date = date;
  entry.dateString = m.toISOString();
  entry.sgv = 100 + Math.round(oscillator(date / 1000, 1/(60*60), 30));
  
  console.log('Adding entry', entry);
  const response = await axios.post(ENTRIES_URL, entry, {headers: HEADERS});

  if (date > Date.now() - 5000) sendFail();
}

(async () => {
    try {
      console.log('GETTING', ENTRIES_URL);
      const response = await axios.get(ENTRIES_URL, {headers: HEADERS} );
      const latestEntry = response.data ? response.data[0] : null;

      if (!latestEntry) {
        // Fill in history
        console.log('I would fill in history');
        const totalToSave = 24;
        const now = Date.now();
        const start = now - ( totalToSave * FIVE_MINUTES);
        let current = start;
        while (current <= now) {
          await sendEntry(current);
          current += FIVE_MINUTES;
        }

        setTimeout(addEntry, 1000*60*5);

      } else {
        let latestDate = latestEntry.date;
        const now = Date.now();
        if ((now - latestDate) > FIVE_MINUTES) {
          console.log('We got data but it is older than 5 minutes, makign a partial fill');

          let current = latestDate + FIVE_MINUTES;
          
          while (current < now) {
            await sendEntry(current);
            current += FIVE_MINUTES;
          }

          latestDate = current;

        } else {
          console.log('Looks like we got history, not filling');
        }
        setTimeout(addEntry, Date.now() - latestDate);
      }

      sendFail();
      sendFail();

    } catch (error) {
      console.log(error.response.data);
    }
  })();

