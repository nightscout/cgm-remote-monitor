/**
 * Author: Ben West
 * https://github.com/bewest
 * Advisor: Scott Hanselman
 * http://www.hanselman.com/blog/BridgingDexcomShareCGMReceiversAndNightscout.aspx
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * 
 *
 * @description: Allows user to store their Dexcom data in their own
 * Nightscout server by facilitating the transfer of latest records
 * from Dexcom's server into theirs.
 */
var request = require('request');
var qs = require('querystring');
var crypto = require('crypto');


// Defaults
var Defaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
, "agent": "Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0"
, login: 'https://share1.dexcom.com/ShareWebServices/Services/General/LoginPublisherAccountByName'
, accept: 'application/json'
, 'content-type': 'application/json'
, LatestGlucose: "https://share1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues"
// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
, nightscout_upload: '/api/v1/entries.json'
};


// assemble the POST body for the login endpoint
function login_payload (opts) {
  var body = {
    "password": opts.password
  , "applicationId" : opts.applicationId || Defaults.applicationId
  , "accountName": opts.accountName
  };
  return body;
}

// Login to Dexcom's server.
function authorize (opts, then) {
  var url = Defaults.login;
  var body = login_payload(opts);
  var headers = { 'User-Agent': Defaults.agent
                , 'Content-Type': Defaults['content-type']
                , 'Accept': Defaults.accept };
  var req ={ uri: url, body: body, json: true, headers: headers, method: 'POST'
           , rejectUnauthorized: false }; 
  // Asynchronously calls the `then` function when the request's I/O
  // is done.
  return request(req, then);
}

// Assemble query string for fetching data.
function fetch_query (opts) {
  // ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
  var q = {
    sessionID: opts.sessionID
  , minutes: opts.minutes || 1440
  , maxCount: opts.maxCount || 1
  };
  var url = Defaults.LatestGlucose + '?' + qs.stringify(q);
  return url;
}

// Asynchronously fetch data from Dexcom's server.
// Will fetch `minutes` and `maxCount` records.
function fetch (opts, then) {
  var url = fetch_query(opts);
  var body = "";
  var headers = { 'User-Agent': Defaults.agent
                , 'Content-Type': Defaults['content-type']
                , 'Content-Length': 0
                , 'Accept': Defaults.accept };

  var req ={ uri: url, body: body, json: true, headers: headers, method: 'POST'
           , rejectUnauthorized: false }; 
  return request(req, then);
}

// Authenticate and fetch data from Dexcom.
function do_everything (opts, then) {
  var login_opts = opts.login;
  var fetch_opts = opts.fetch;
  authorize(login_opts, function (err, res, body) {

    fetch_opts.sessionID = body;
    fetch(fetch_opts, function (err, res, glucose) {
      then(err, glucose);

    });
  });

}

// Map Dexcom's property values to Nightscout's.
function dex_to_entry (d) {
/*
[ { DT: '/Date(1426292016000-0700)/',
    ST: '/Date(1426295616000)/',
    Trend: 4,
    Value: 101,
    WT: '/Date(1426292039000)/' } ]
*/
  var regex = /\((.*)\)/;
  var wall = parseInt(d.WT.match(regex)[1]);
  var date = new Date(wall);
  var entry = {
    sgv: d.Value
  , date: wall
  , dateString: date.toISOString( )
  , trend: d.Trend
  , device: 'share2'
  , type: 'sgv'
  // , device: 'dexcom'
  };
  return entry;
}

// Record data into Nightscout.
function report_to_nightscout (opts, then) {
  var shasum = crypto.createHash('sha1');
  var hash = shasum.update(opts.API_SECRET);
  var headers = { 'api-secret': shasum.digest('hex')
                , 'Content-Type': Defaults['content-type']
                , 'Accept': Defaults.accept };
  var url = opts.endpoint + Defaults.nightscout_upload;
  var req = { uri: url, body: opts.entries, json: true, headers: headers, method: 'POST'
            , rejectUnauthorized: false }; 
  return request(req, then);

}

function engine (opts) {

  var failures = 0;
  function my ( ) {
    console.log('RUNNING', 'failures', failures);
    if (my.sessionID) {
      var fetch_opts = new Object(opts.fetch);
      fetch_opts.sessionID = my.sessionID;
      fetch(fetch_opts, function (err, res, glucose) {
        if (res.statusCode < 400) {
          to_nightscout(glucose);
        } else {
          my.sessionID = null;
          refresh_token( );
        }
      });
    } else {
      failures++;
      refresh_token( );
    }
  }

  function refresh_token ( ) {
    console.log('Fetching new token');
    authorize(opts.login, function (err, res, body) {
      if (!err && body) {
        my.sessionID = body;
        failures = 0;
        my( );
      } else {
        failures++;
        console.log("Error refreshing token", err);
      }
    });
  }

  function to_nightscout (glucose) {
    var ns_config = new Object(opts.nightscout);
    if (glucose) {
      // Translate to Nightscout data.
      var entries = glucose.map(dex_to_entry);
      console.log('Entries', entries);
      if (ns_config.endpoint) {
        ns_config.entries = entries;
        // Send data to Nightscout.
        report_to_nightscout(ns_config, function (err, response, body) {
          console.log("Nightscout upload", 'error', err, 'status', response.statusCode, body);

        });
      }
    }
  }
  my( );

  return my;
}

// Provide public, testable API
engine.fetch = fetch;
engine.authorize = authorize;
engine.authorize_fetch = do_everything;
module.exports = engine;


// If run from commandline, run the whole program.
if (!module.parent) {
  var args = process.argv.slice(2);
  var config = {
    accountName: process.env['DEXCOM_ACCOUNT_NAME']
  , password: process.env['DEXCOM_PASSWORD']
  };
  var ns_config = {
    API_SECRET: process.env['API_SECRET']
  , endpoint: process.env['NS']
  };
  var interval = process.env['SHARE_INTERVAL'] || 60000 * 5;
  var fetch_config = { maxCount: process.env.maxCount || 1, minutes: process.env.minutes || 1440 };
  var meta = {
    login: config
  , fetch: fetch_config
  , nightscout: ns_config
  };
  switch (args[0]) {
    case 'login':
      authorize(config, console.log.bind(console, 'login'));
      break;
    case 'fetch':
      config = { sessionID: args[1] };
      fetch(config, console.log.bind(console, 'fetched'));
      break;
    case 'testdaemon':
      setInterval(engine(meta), 2500);
      break;
    case 'run':
      // Authorize and fetch from Dexcom.
      do_everything(meta, function (err, glucose) {
        console.log('From Dexcom', err, glucose);
        if (glucose) {
          // Translate to Nightscout data.
          var entries = glucose.map(dex_to_entry);
          console.log('Entries', entries);
          if (ns_config.endpoint) {
            ns_config.entries = entries;
            // Send data to Nightscout.
            report_to_nightscout(ns_config, function (err, response, body) {
              console.log("Nightscout upload", 'error', err, 'status', response.statusCode, body);

            });
          }
        }
      });
      break;
    default:
      setInterval(engine(meta), interval);
      break;
      break;
  }
}
