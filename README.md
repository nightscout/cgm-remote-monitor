Nightscout Web Monitor (a.k.a. cgm-remote-monitor)
======================================

[![Build Status][build-img]][build-url]
[![Dependency Status][dependency-img]][dependency-url]
[![Coverage Status][coverage-img]][coverage-url]
[![Gitter chat][gitter-img]][gitter-url]
[![Stories in Ready][ready-img]][waffle]
[![Stories in Progress][progress-img]][waffle]

[![Deploy to Heroku][heroku-img]][heroku-url]

This acts as a web-based CGM (Continuous Glucose Monitor) to allow
multiple caregivers to remotely view a patient's glucose data in
real time.  The server reads a MongoDB which is intended to be data
from a physical CGM, where it sends new SGV (sensor glucose values) as
the data becomes available.  The data is then displayed graphically
and blood glucose values are predicted 0.5 hours ahead using an
autoregressive second order model.  Alarms are generated for high and
low values, which can be cleared by any watcher of the data.

#[#WeAreNotWaiting](https://twitter.com/hashtag/wearenotwaiting?src=hash&vertical=default&f=images) and [this](https://vimeo.com/109767890) is why.

Community maintained fork of the
[original cgm-remote-monitor][original].

[build-img]: https://img.shields.io/travis/nightscout/cgm-remote-monitor.svg
[build-url]: https://travis-ci.org/nightscout/cgm-remote-monitor
[dependency-img]: https://img.shields.io/david/nightscout/cgm-remote-monitor.svg
[dependency-url]: https://david-dm.org/nightscout/cgm-remote-monitor
[coverage-img]: https://img.shields.io/coveralls/nightscout/cgm-remote-monitor/master.svg
[coverage-url]: https://coveralls.io/r/nightscout/cgm-remote-monitor?branch=master
[gitter-img]: https://img.shields.io/badge/Gitter-Join%20Chat%20%E2%86%92-1dce73.svg
[gitter-url]: https://gitter.im/nightscout/public
[ready-img]: https://badge.waffle.io/nightscout/cgm-remote-monitor.svg?label=ready&title=Ready
[waffle]: https://waffle.io/nightscout/cgm-remote-monitor
[progress-img]: https://badge.waffle.io/nightscout/cgm-remote-monitor.svg?label=in+progress&title=In+Progress
[heroku-img]: https://www.herokucdn.com/deploy/button.png
[heroku-url]: https://heroku.com/deploy
[original]: https://github.com/rnpenguin/cgm-remote-monitor

Install
---------------

Requirements:

- [Node.js](http://nodejs.org/)

Clone this repo then install dependencies into the root of the project:

```bash
$ npm install
```

Usage
---------------

The data being uploaded from the server to the client is from a
MongoDB server such as [mongolab][mongodb].  In order to access the
database, the appropriate credentials need to be filled into the
[JSON][json] file in the root directory.  SGV data from the database
is assumed to have the following fields: date, sgv.  Once all that is
ready, just host your web app on your service of choice.

[mongodb]: https://mongolab.com
[json]: https://github.com/rnpenguin/cgm-remote-monitor/blob/master/database_configuration.json
[autoconfigure]: http://nightscout.github.io/pages/configure/
[mongostring]: http://nightscout.github.io/pages/mongostring/
[update-fork]: http://nightscout.github.io/pages/update-fork/

### Updating my version?
The easiest way to update your version of cgm-remote-monitor to our latest
recommended version is to use the [update my fork tool][update-fork].  It even
gives out stars if you are up to date.

### What is my mongo string?

Try the [what is my mongo string tool][mongostring] to get a good idea of your
mongo string.  You can copy and paste the text in the gray box into your
`MONGO_CONNECTION` environment variable.

### Configure my uploader to match

Use the [autoconfigure tool][autoconfigure] to sync an uploader to your config.


### Environment

`VARIABLE` (default) - description

#### Required

  * `MONGO_CONNECTION` - Your mongo uri, for example: `mongodb://sally:sallypass@ds099999.mongolab.com:99999/nightscout`

#### Features/Labs

  * `ENABLE` - Used to enable optional features, expects a space delimited list such as: `careportal rawbg iob`, see [plugins](#plugins) below
  * `API_SECRET` - A secret passphrase that must be at least 12 characters long, required to enable `POST` and `PUT`; also required for the Care Portal
  * `BG_HIGH` (`260`) - must be set using mg/dl units; the high BG outside the target range that is considered urgent
  * `BG_TARGET_TOP` (`180`) - must be set using mg/dl units; the top of the target range, also used to draw the line on the chart
  * `BG_TARGET_BOTTOM` (`80`) - must be set using mg/dl units; the bottom of the target range, also used to draw the line on the chart
  * `BG_LOW` (`55`) - must be set using mg/dl units; the low BG outside the target range that is considered urgent
  * `ALARM_TYPES` (`simple` if any `BG_`* ENV's are set, otherwise `predict`) - currently 2 alarm types are supported, and can be used independently or combined.  The `simple` alarm type only compares the current BG to `BG_` thresholds above, the `predict` alarm type uses highly tuned formula that forecasts where the BG is going based on it's trend.  `predict` **DOES NOT** currently use any of the `BG_`* ENV's
  * `BASE_URL` - Used for building links to your sites api, ie pushover callbacks, usually the URL of your Nightscout site you may want https instead of http
  * `PUSHOVER_API_TOKEN` - Used to enable pushover notifications, this token is specific to the application you create from in [Pushover](https://pushover.net/), ***[additional pushover information](#pushover)*** below.
  * `PUSHOVER_USER_KEY` - Your Pushover user key, can be found in the top left of the [Pushover](https://pushover.net/) site, this can also be a pushover delivery group key to send to a group rather than just a single user.


#### Core

  * `DISPLAY_UNITS` (`mg/dl`) - Choices: `mg/dl` and `mmol`.  Setting to `mmol` puts the entire server into `mmol` mode by default, no further settings needed.
  * `MONGO_COLLECTION` (`entries`) - The collection used to store SGV, MBG, and CAL records from your CGM device
  * `MONGO_TREATMENTS_COLLECTION` (`treatments`) -The collection used to store treatments entered in the Care Portal, see the `ENABLE` env var above
  * `MONGO_DEVICESTATUS_COLLECTION`(`devicestatus`) - The collection used to store device status information such as uploader battery
  * `PORT` (`1337`) - The port that the node.js application will listen on.
  * `SSL_KEY` - Path to your ssl key file, so that ssl(https) can be enabled directly in node.js
  * `SSL_CERT` - Path to your ssl cert file, so that ssl(https) can be enabled directly in node.js
  * `SSL_CA` - Path to your ssl ca file, so that ssl(https) can be enabled directly in node.js


#### Predefined values for your browser settings (optional)
  * `TIME_FORMAT` (`12`)- possible values `12` or `24`
  * `NIGHT_MODE` (`off`) - possible values `on` or `off`
  * `SHOW_RAWBG` (`never`) - possible values `always`, `never` or `noise`
  * `CUSTOM_TITLE` (`Nightscout`) - Usually name of T1
  * `THEME` (`default`) - possible values `default` or `colors`
  * `ALARM_URGENT_HIGH` (`on`) - possible values `on` or `off`
  * `ALARM_HIGH` (`on`) - possible values `on` or `off`
  * `ALARM_LOW` (`on`) - possible values `on` or `off`
  * `ALARM_URGENT_LOW` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_WARN` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_WARN_MINS` (`15`) - minutes since the last reading to trigger a warning
  * `ALARM_TIMEAGO_URGENT` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_URGENT_MINS` (`30`) - minutes since the last reading to trigger a urgent alarm
  * `SHOW_PLUGINS` - enabled plugins that should have their visualizations shown, defaults to all enabled


### Plugins

  Plugins are used extend the way information is displayed, how notifications are sent, alarms are triggered, and more.

  The built-in/example plugins that are available by default are listed below.  The plugins may still need to be enabled by adding the to the `ENABLE` environment variable.

  **Built-in/Example Plugins:**

  * `rawbg` (Raw BG) - Calculates BG using sensor and calibration records from and displays an alternate BG values and noise levels.
  * `iob` (Insulin-on-Board) - Adds the IOB pill visualization in the client and calculates values that used by other plugins.  Uses treatments with insulin doses and the `dia` and `sens` fields from the [treatment profile](#treatment-profile).
  * `cob` (Carbs-on-Board) - Adds the COB pill visualization in the client and calculates values that used by other plugins.  Uses treatments with carb doses and the `carbs_hr`, `carbratio`, and `sens` fields from the [treatment profile](#treatment-profile).
  * `bwp` (Bolus Wizard Preview) - This plugin in intended for the purpose of automatically snoozing alarms when the CGM indicates high blood sugar but there is also insulin on board (IOB) and secondly, alerting to user that it might be beneficial to measure the blood sugar using a glucometer and dosing insulin as calculated by the pump or instructed by trained medicare professionals. ***The values provided by the plugin are provided as a reference based on CGM data and insulin sensitivity you have configured, and are not intended to be used as a reference for bolus calculation.*** The plugin calculates the bolus amount when above your target, generates alarms when you should consider checking and bolusing, and snoozes alarms when there is enough IOB to cover a high BG. Uses the results of the `iob` plugin and `sens`, `target_high`, and `target_low` fields from the [treatment profile](#treatment-profile). Defaults that can be adjusted with [extended setting](#extended-settings)
    * `BWP_WARN` (`0.50`) - If `BWP` is > `BWP_WARN` a warning alarm will be triggered.
    * `BWP_URGENT` (`1.00`) - If `BWP` is > `BWP_URGENT` an urgent alarm will be triggered.
    * `BWP_SNOOZE_MINS` (`10`) - minutes to snooze when there is enough IOB to cover a high BG.
    * `BWP_SNOOZE` - (`0.10`) If BG is higher then the `target_high` and `BWP` < `BWP_SNOOZE` alarms will be snoozed for `BWP_SNOOZE_MINS`.
  * `cage` (Cannula Age) - Calculates the number of hours since the last `Site Change` treatment that was recorded.
  * `delta` (BG Delta) - Calculates and displays the change between the last 2 BG values.  **Enabled by default.**
  * `upbat` (Uploader Battery) - Displays the most recent battery status from the uploader phone.  **Enabled by default.**
  * `ar2` ([Forcasting using AR2 algorithm](https://github.com/nightscout/nightscout.github.io/wiki/Forecasting)) - Generates alarms based on forecasted values.  **Enabled by default.**  Use [extended setting](#extended-settings) `AR2_USE_RAW=true` to forecast using `rawbg` values.
  * `simplealarms` (Simple BG Alarms) - Uses  `BG_HIGH`, `BG_TARGET_TOP`, `BG_TARGET_BOTTOM`, `BG_LOW` settings to generate alarms.
  * `errorcodes` (CGM Error Codes) - Generates alarms for CGM codes `9` (hourglass) and `10` (???).  **Enabled by default.**
  * `treatmentnotify` (Treatment Notifications) - Generates notifications when a treatment has been entered and snoozes alarms minutes after a treatment.  Default snooze is 10 minutes, and can be set using the `TREATMENTNOTIFY_SNOOZE_MINS` [extended setting](#extended-settings).
  * `basal` (Basal Profile) - Adds the Basal pill visualization to display the basal rate for the current time.  Also enables the `bwp` plugin to calculate correction temp basal suggestions.  Uses the `basal` field from the [treatment profile](#treatment-profile).

#### Extended Settings
  Some plugins support additional configuration using extra environment variables.  These are prefixed with the name of the plugin and a `_`.  For example setting `MYPLUGIN_EXAMPLE_VALUE=1234` would make `extendedSettings.exampleValue` available to the `MYPLUGIN` plugin.

  Plugins only have access to their own extended settings, all the extended settings of client plugins will be sent to the browser.

### Treatment Profile
  Some of the [plugins](#plugins) make use of a treatment profile that is stored in Mongo. To use those plugins there should only be a single doc in the `profile` collection.  A simple example (change it to fit you):

  ```json
  {
    "dia": 4,
    "carbs_hr": 30,
    "carbratio": 7.5,
    "sens": 35,
    "basal": 1.00
    "target_low": 95,
    "target_high": 120
  }
  ```
  
  Profiles can also use time periods for any field, for example:
  
  ```json
  {
    "carbratio": [
      {
        "time": "00:00",
        "value": 16
      },
      {
        "time": "06:00",
        "value": 15
      },
      {
        "time": "14:00",
        "value": 16
      }
    ],
    "basal": [
      {
        "time": "00:00",
        "value": 0.175
      },
      {
        "time": "02:30",
        "value": 0.125
      },
      {
        "time": "05:00",
        "value": 0.075
      },
      {
        "time": "08:00",
        "value": 0.1
      },
      {
        "time": "14:00",
        "value": 0.125
      },
      {
        "time": "20:00",
        "value": 0.3
      },
      {
        "time": "22:00",
        "value": 0.225
      }
    ]
  }
  ```

  Treatment Profile Fields:

  * `dia` (Insulin duration) - value should be the duration of insulin action to use in calculating how much insulin is left active. Defaults to 3 hours.
  * `carbs_hr` (Carbs per Hour) - The number of carbs that are processed per hour, for more information see [#DIYPS](http://diyps.org/2014/05/29/determining-your-carbohydrate-absorption-rate-diyps-lessons-learned/).
  * `carbratio` (Carb Ratio) - grams per unit of insulin.
  * `sens` (Insulin sensitivity) How much one unit of insulin will normally lower blood glucose.
  * `basal` The basal rate set on the pump.
  * `target_high` - Upper target for correction boluses.
  * `target_low` - Lower target for correction boluses.

  Additional information can be found [here](http://www.nightscout.info/wiki/labs/the-nightscout-iob-cob-website).

### Pushover
  In addition to the normal web based alarms, there is also support for [Pushover](https://pushover.net/) based alarms and notifications.

  To get started install the Pushover application on your iOS or Android device and create an account.

  Using that account login to [Pushover](https://pushover.net/), in the top left you’ll see your User Key, you’ll need this plus an application API Token/Key to complete this setup.

  You’ll need to [Create a Pushover Application](https://pushover.net/apps/build).  You only need to set the Application name, you can ignore all the other settings, but setting an Icon is a nice touch.  Maybe you'd like to use [this one](https://raw.githubusercontent.com/nightscout/cgm-remote-monitor/master/static/images/large.png)?

  Pushover is configured using the `PUSHOVER_API_TOKEN`, `PUSHOVER_USER_KEY`, `BASE_URL`, and `API_SECRET` environment variables. For acknowledgment callbacks to work `BASE_URL` and `API_SECRET` must be set and `BASE_URL` must be publicly accessible.  For testing/devlopment try [localtunnel](http://localtunnel.me/).

## Setting environment variables
Easy to emulate on the commandline:

```bash
    echo 'MONGO_CONNECTION=mongodb://sally:sallypass@ds099999.mongolab.com:99999/nightscout' >> my.env
    echo 'MONGO_COLLECTION=entries' >> my.env
```

From now on you can run using
```bash
    $ env $(cat my.env) PORT=1337 node server.js
```

Your hosting provider probably has a way to set these through their GUI.

### Vagrant install

Optionally, use [Vagrant](https://www.vagrantup.com/) with the
included `Vagrantfile` and `setup.sh` to install OS and node packages to
a virtual machine.

```bash
host$ vagrant up
host$ vagrant ssh
vm$ setup.sh
```

The setup script will install OS packages then run `npm install`.

The Vagrant VM serves to your host machine only on 192.168.33.10, you can access
the web interface on [http://192.168.33.10:1337](http://192.168.33.10:1337)

More questions?
---------------

Feel free to [post an issue][issues], but read the [wiki][wiki] first.

[issues]: https://github.com/nightscout/cgm-remote-monitor/issues
[wiki]: https://github.com/nightscout/cgm-remote-monitor/wiki

License
---------------

[agpl-3]: http://www.gnu.org/licenses/agpl-3.0.txt

    cgm-remote-monitor - web app to broadcast cgm readings
    Copyright (C) 2015 The Nightscout Foundation, http://www.nightscoutfoundation.org.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
