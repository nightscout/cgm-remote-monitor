cgm-remote-monitor (a.k.a. Nightscout)
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

  * `ENABLE` - Used to enable optional features, expects a space delimited list such as: `careportal rawbg iob`
  * `API_SECRET` - A secret passphrase that must be at least 12 characters long, required to enable `POST` and `PUT`; also required for the Care Portal
  * `BG_HIGH` (`260`) - must be set using mg/dl units; the high BG outside the target range that is considered urgent
  * `BG_TARGET_TOP` (`180`) - must be set using mg/dl units; the top of the target range, also used to draw the line on the chart
  * `BG_TARGET_BOTTOM` (`80`) - must be set using mg/dl units; the bottom of the target range, also used to draw the line on the chart
  * `BG_LOW` (`55`) - must be set using mg/dl units; the low BG outside the target range that is considered urgent
  * `ALARM_TYPES` (`simple` if any `BG_`* ENV's are set, otherwise `predict`) - currently 2 alarm types are supported, and can be used independently or combined.  The `simple` alarm type only compares the current BG to `BG_` thresholds above, the `predict` alarm type uses highly tuned formula that forecasts where the BG is going based on it's trend.  `predict` **DOES NOT** currently use any of the `BG_`* ENV's
  * `PUSHOVER_API_TOKEN` - Used to enable pushover notifications for Care Portal treatments, this token is specific to the application you create from in [Pushover](https://pushover.net/)
  * `PUSHOVER_USER_KEY` - Your Pushover user key, can be found in the top left of the [Pushover](https://pushover.net/) site


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
