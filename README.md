Nightscout Web Monitor (a.k.a. cgm-remote-monitor)
======================================

![nightscout horizontal](https://cloud.githubusercontent.com/assets/751143/8425633/93c94dc0-1ebc-11e5-99e7-71a8f464caac.png)

[![Build Status][build-img]][build-url]
[![Dependency Status][dependency-img]][dependency-url]
[![Coverage Status][coverage-img]][coverage-url]
[![Codacy Badge][codacy-img]][codacy-url]
[![Gitter chat][gitter-img]][gitter-url]

[![Deploy to Azure](http://azuredeploy.net/deploybutton.png)](https://azuredeploy.net/) [![Deploy to Heroku][heroku-img]][heroku-url]

This acts as a web-based CGM (Continuous Glucose Monitor) to allow
multiple caregivers to remotely view a patient's glucose data in
real time.  The server reads a MongoDB which is intended to be data
from a physical CGM, where it sends new SGV (sensor glucose values) as
the data becomes available.  The data is then displayed graphically
and blood glucose values are predicted 0.5 hours ahead using an
autoregressive second order model.  Alarms are generated for high and
low values, which can be cleared by any watcher of the data.

# [#WeAreNotWaiting](https://twitter.com/hashtag/wearenotwaiting?src=hash&vertical=default&f=images) and [this](https://vimeo.com/109767890) is why.

Community maintained fork of the
[original cgm-remote-monitor][original].

[![Coverage Status](https://coveralls.io/repos/github/nightscout/cgm-remote-monitor/badge.svg?branch=master)](https://coveralls.io/github/nightscout/cgm-remote-monitor?branch=master)

[build-img]: https://img.shields.io/travis/nightscout/cgm-remote-monitor.svg
[build-url]: https://travis-ci.org/nightscout/cgm-remote-monitor
[dependency-img]: https://img.shields.io/david/nightscout/cgm-remote-monitor.svg
[dependency-url]: https://david-dm.org/nightscout/cgm-remote-monitor
[coverage-img]: https://img.shields.io/coveralls/nightscout/cgm-remote-monitor/dev.svg
[coverage-url]: https://coveralls.io/github/nightscout/cgm-remote-monitor?branch=master
[codacy-img]: https://www.codacy.com/project/badge/f79327216860472dad9afda07de39d3b
[codacy-url]: https://www.codacy.com/app/Nightscout/cgm-remote-monitor
[gitter-img]: https://img.shields.io/badge/Gitter-Join%20Chat%20%E2%86%92-1dce73.svg
[gitter-url]: https://gitter.im/nightscout/public
[heroku-img]: https://www.herokucdn.com/deploy/button.png
[heroku-url]: https://heroku.com/deploy
[original]: https://github.com/rnpenguin/cgm-remote-monitor

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Install](#install)
- [Usage](#usage)
  - [Updating my version?](#updating-my-version)
  - [What is my mongo string?](#what-is-my-mongo-string)
  - [Configure my uploader to match](#configure-my-uploader-to-match)
  - [Nightscout API](#nightscout-api)
      - [Example Queries](#example-queries)
  - [Environment](#environment)
    - [Required](#required)
    - [Features/Labs](#featureslabs)
    - [Alarms](#alarms)
    - [Core](#core)
    - [Predefined values for your browser settings (optional)](#predefined-values-for-your-browser-settings-optional)
    - [Views](#views)
    - [Plugins](#plugins)
      - [Default Plugins](#default-plugins)
        - [`delta` (BG Delta)](#delta-bg-delta)
        - [`direction` (BG Direction)](#direction-bg-direction)
        - [`upbat` (Uploader Battery)](#upbat-uploader-battery)
        - [`timeago` (Time Ago)](#timeago-time-ago)
        - [`devicestatus` (Device Status)](#devicestatus-device-status)
        - [`errorcodes` (CGM Error Codes)](#errorcodes-cgm-error-codes)
        - [`ar2` (AR2 Forecasting)](#ar2-ar2-forecasting)
        - [`simplealarms` (Simple BG Alarms)](#simplealarms-simple-bg-alarms)
        - [`profile` (Treatment Profile)](#profile-treatment-profile)
      - [Advanced Plugins](#advanced-plugins)
        - [`careportal` (Careportal)](#careportal-careportal)
        - [`boluscalc` (Bolus Wizard)](#boluscalc-bolus-wizard)
        - [`food` (Custom Foods)](#food-custom-foods)
        - [`rawbg` (Raw BG)](#rawbg-raw-bg)
        - [`iob` (Insulin-on-Board)](#iob-insulin-on-board)
        - [`cob` (Carbs-on-Board)](#cob-carbs-on-board)
        - [`bwp` (Bolus Wizard Preview)](#bwp-bolus-wizard-preview)
        - [`cage` (Cannula Age)](#cage-cannula-age)
        - [`sage` (Sensor Age)](#sage-sensor-age)
        - [`iage` (Insulin Age)](#iage-insulin-age)
        - [`treatmentnotify` (Treatment Notifications)](#treatmentnotify-treatment-notifications)
        - [`basal` (Basal Profile)](#basal-basal-profile)
        - [`bridge` (Share2Nightscout bridge)](#bridge-share2nightscout-bridge)
        - [`mmconnect` (MiniMed Connect bridge)](#mmconnect-minimed-connect-bridge)
        - [`pump` (Pump Monitoring)](#pump-pump-monitoring)
        - [`openaps` (OpenAPS)](#openaps-openaps)
        - [`loop` (Loop)](#loop-loop)
        - [`xdrip-js` (xDrip-js)](#xdrip-js-xdrip-js)
        - [`alexa` (Amazon Alexa)](#alexa-amazon-alexa)
        - [`cors` (CORS)](#cors-cors)
      - [Extended Settings](#extended-settings)
      - [Pushover](#pushover)
      - [IFTTT Maker](#ifttt-maker)
    - [Treatment Profile](#treatment-profile)
  - [Setting environment variables](#setting-environment-variables)
    - [Vagrant install](#vagrant-install)
  - [More questions?](#more-questions)
  - [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Install

Supported configurations:

If you plan to use Nightscout, we recommend using [Heroku](http://openaps.readthedocs.io/en/latest/docs/While%20You%20Wait%20For%20Gear/nightscout-setup.html#nightscout-setup-with-heroku), as Nightscout can reach the usage limits of the free Azure plan and cause it to shut down for hours or days. If you end up needing a paid tier, the $7/mo Heroku plan is also much cheaper than the first paid tier of Azure. Currently, the only added benefit to choosing the $7/mo Heroku plan vs the free Heroku plan is a section showing site use metrics for performance (such as response time). This has limited benefit to the average Nightscout user. In short, Heroku is the free and best option for Nightscout hosting.

- [Nightscout Setup with Heroku] (http://openaps.readthedocs.io/en/latest/docs/While%20You%20Wait%20For%20Gear/nightscout-setup.html#nightscout-setup-with-heroku) (recommended)
- [Nightscout Setup with Microsoft Azure] (http://www.nightscout.info/wiki/faqs-2/azure-2) (not recommended, please 
[switch from Azure to Heroku](http://openaps.readthedocs.io/en/latest/docs/While%20You%20Wait%20For%20Gear/nightscout-setup.html#switching-from-azure-to-heroku) )
- Linux based install (Debian, Ubuntu, Raspbian) install with own Node.JS and MongoDB install (see software requirements below)
- Windows based install with own Node.JS and MongoDB install (see software requirements below)

Software requirements:

- [Node.js](http://nodejs.org/) Latest Node 8 LTS (Node 8.11.3 or later). Use [Install instructions for Node](https://nodejs.org/en/download/package-manager/) or use `setup.sh`)
- [MongoDB](https://www.mongodb.com/download-center?jmp=nav#community) 3.x or later. MongoDB 2.4 is only supported for Raspberry Pi.

As a non-root user clone this repo then install dependencies into the root of the project:

```bash
$ npm install
```

Installation notes for Microsoft Azure, Windows and Node 10: 

- If deploying the software to Microsoft Azure, you must set ** in the app settings for *WEBSITE_NODE_DEFAULT_VERSION* and *SCM_COMMAND_IDLE_TIMEOUT* **before** you deploy the latest Nightscout or the site deployment will likely fail. Other hosting environments do not require this setting. Please use:
```
WEBSITE_NODE_DEFAULT_VERSION=8.11.1
SCM_COMMAND_IDLE_TIMEOUT=300
```
- See [install MongoDB, Node.js, and Nightscouton a single Windows system](https://github.com/jaylagorio/Nightscout-on-Windows-Server). if you want to host your Nightscout outside of the cloud. Although the instructions are intended for Windows Server the procedure is compatible with client versions of Windows such as Windows 7 and Windows 10.
- If you deploy to Windows and want to develop or test you need to install [Cygwin] (https://www.cygwin.com/) (use [setup-x86_64.exe] (https://www.cygwin.com/setup-x86_64.exe) and make sure to install `build-essential` package. Test your configuration by executing `make` and check if all tests are ok. 
- There may be some issues with Node 10.6.0 or later with Nightscout. Node 10 support will be in the 0.11 release. Please don't use Nightscout with (Node 9 or) Node 10 at this moment.

# Usage

The data being uploaded from the server to the client is from a
MongoDB server such as [mongolab][mongodb].

[mongodb]: https://mongolab.com
[autoconfigure]: https://nightscout.github.io/pages/configure/
[mongostring]: https://nightscout.github.io/pages/mongostring/
[update-fork]: http://nightscout.github.io/pages/update-fork/

## Updating my version?
The easiest way to update your version of cgm-remote-monitor to our latest
recommended version is to use the [update my fork tool][update-fork].  It even
gives out stars if you are up to date.

## What is my mongo string?

Try the [what is my mongo string tool][mongostring] to get a good idea of your
mongo string.  You can copy and paste the text in the gray box into your
`MONGO_CONNECTION` environment variable.

## Configure my uploader to match

Use the [autoconfigure tool][autoconfigure] to sync an uploader to your config.


## Nightscout API

The Nightscout API enables direct access to your DData without the need for direct Mongo access.
You can find CGM data in `/api/v1/entries`, Care Portal Treatments in `/api/v1/treatments`, and Treatment Profiles in `/api/v1/profile`.
The server status and settings are available from `/api/v1/status.json`.

By default the `/entries` and `/treatments` APIs limit results to the the most recent 10 values from the last 2 days.
You can get many more results, by using the `count`, `date`, `dateString`, and `created_at` parameters, depending on the type of data you're looking for.

#### Example Queries

(replace `http://localhost:1337` with your base url, YOUR-SITE)

  * 100's: `http://localhost:1337/api/v1/entries.json?find[sgv]=100`
  * Count of 100's in a month: `http://localhost:1337/api/v1/count/entries/where?find[dateString][$gte]=2016-09&find[dateString][$lte]=2016-10&find[sgv]=100`
  * BGs between 2 days: `http://localhost:1337/api/v1/entries/sgv.json?find[dateString][$gte]=2015-08-28&find[dateString][$lte]=2015-08-30`
  * Juice Box corrections in a year: `http://localhost:1337/api/v1/treatments.json?count=1000&find[carbs]=15&find[eventType]=Carb+Correction&find[created_at][$gte]=2015`
  * Boluses over 2U: `http://localhost:1337/api/v1/treatments.json?find[insulin][$gte]=2`

The API is Swagger enabled, so you can generate client code to make working with the API easy.
To learn more about the Nightscout API, visit https://YOUR-SITE.com/api-docs.html or review [swagger.yaml](swagger.yaml).


## Environment

`VARIABLE` (default) - description

### Required

  * `MONGO_CONNECTION` - Your mongo uri, for example: `mongodb://sally:sallypass@ds099999.mongolab.com:99999/nightscout`
  * `DISPLAY_UNITS` (`mg/dl`) - Choices: `mg/dl` and `mmol`.  Setting to `mmol` puts the entire server into `mmol` mode by default, no further settings needed.
  * `BASE_URL` - Used for building links to your sites api, ie pushover callbacks, usually the URL of your Nightscout site you may want https instead of http

### Features/Labs

  * `ENABLE` - Used to enable optional features, expects a space delimited list, such as: `careportal rawbg iob`, see [plugins](#plugins) below
  * `DISABLE` - Used to disable default features, expects a space delimited list, such as: `direction upbat`, see [plugins](#plugins) below
  * `API_SECRET` - A secret passphrase that must be at least 12 characters long, required to enable `POST` and `PUT`; also required for the Care Portal
  * `AUTH_DEFAULT_ROLES` (`readable`) - possible values `readable`, `denied`, or any valid role
    name.  When `readable`, anyone can view Nightscout without a token.
    Setting it to `denied` will require a token from every visit, using `status-only` will enable api-secret based login.
  * `IMPORT_CONFIG` - Used to import settings and extended settings from a url such as a gist.  Structure of file should be something like: `{"settings": {"theme": "colors"}, "extendedSettings": {"upbat": {"enableAlerts": true}}}`
  * `TREATMENTS_AUTH` (`on`) - possible values `on` or `off`. Deprecated, if set to `off` the `careportal` role will be added to `AUTH_DEFAULT_ROLES`


### Alarms

  These alarm setting effect all delivery methods (browser, pushover, maker, etc), some settings can be overridden per client (web browser)

  * `ALARM_TYPES` (`simple` if any `BG_`* ENV's are set, otherwise `predict`) - currently 2 alarm types are supported, and can be used independently or combined.  The `simple` alarm type only compares the current BG to `BG_` thresholds above, the `predict` alarm type uses highly tuned formula that forecasts where the BG is going based on it's trend.  `predict` **DOES NOT** currently use any of the `BG_`* ENV's
  * `BG_HIGH` (`260`) - must be set using mg/dl units; the high BG outside the target range that is considered urgent
  * `BG_TARGET_TOP` (`180`) - must be set using mg/dl units; the top of the target range, also used to draw the line on the chart
  * `BG_TARGET_BOTTOM` (`80`) - must be set using mg/dl units; the bottom of the target range, also used to draw the line on the chart
  * `BG_LOW` (`55`) - must be set using mg/dl units; the low BG outside the target range that is considered urgent
  * `ALARM_URGENT_HIGH` (`on`) - possible values `on` or `off`
  * `ALARM_URGENT_HIGH_MINS` (`30 60 90 120`) - Number of minutes to snooze urgent high alarms, space separated for options in browser, first used for pushover
  * `ALARM_HIGH` (`on`) - possible values `on` or `off`
  * `ALARM_HIGH_MINS` (`30 60 90 120`) - Number of minutes to snooze high alarms, space separated for options in browser, first used for pushover
  * `ALARM_LOW` (`on`) - possible values `on` or `off`
  * `ALARM_LOW_MINS` (`15 30 45 60`) - Number of minutes to snooze low alarms, space separated for options in browser, first used for pushover
  * `ALARM_URGENT_LOW` (`on`) - possible values `on` or `off`
  * `ALARM_URGENT_LOW_MINS` (`15 30 45`) - Number of minutes to snooze urgent low alarms, space separated for options in browser, first used for pushover
  * `ALARM_URGENT_MINS` (`30 60 90 120`) - Number of minutes to snooze urgent alarms (that aren't tagged as high or low), space separated for options in browser, first used for pushover
  * `ALARM_WARN_MINS` (`30 60 90 120`) - Number of minutes to snooze warning alarms (that aren't tagged as high or low), space separated for options in browser, first used for pushover


### Core

  * `MONGO_COLLECTION` (`entries`) - The collection used to store SGV, MBG, and CAL records from your CGM device
  * `MONGO_TREATMENTS_COLLECTION` (`treatments`) -The collection used to store treatments entered in the Care Portal, see the `ENABLE` env var above
  * `MONGO_DEVICESTATUS_COLLECTION`(`devicestatus`) - The collection used to store device status information such as uploader battery
  * `MONGO_PROFILE_COLLECTION`(`profile`) - The collection used to store your profiles
  * `MONGO_FOOD_COLLECTION`(`food`) - The collection used to store your food database
  * `MONGO_ACTIVITY_COLLECTION`(`activity`) - The collection used to store activity data
  * `PORT` (`1337`) - The port that the node.js application will listen on.
  * `HOSTNAME` - The hostname that the node.js application will listen on, null by default for any hostname for IPv6 you may need to use `::`.
  * `SSL_KEY` - Path to your ssl key file, so that ssl(https) can be enabled directly in node.js
  * `SSL_CERT` - Path to your ssl cert file, so that ssl(https) can be enabled directly in node.js
  * `SSL_CA` - Path to your ssl ca file, so that ssl(https) can be enabled directly in node.js
  * `HEARTBEAT` (`60`)  - Number of seconds to wait in between database checks
  * `DEBUG_MINIFY` (`true`)  - Debug option, setting to `false` will disable bundle minification to help tracking down error and speed up development


### Predefined values for your browser settings (optional)
  * `TIME_FORMAT` (`12`)- possible values `12` or `24`
  * `NIGHT_MODE` (`off`) - possible values `on` or `off`
  * `SHOW_RAWBG` (`never`) - possible values `always`, `never` or `noise`
  * `CUSTOM_TITLE` (`Nightscout`) - Usually name of T1
  * `THEME` (`default`) - possible values `default`, `colors`, or `colorblindfriendly`
  * `ALARM_TIMEAGO_WARN` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_WARN_MINS` (`15`) - minutes since the last reading to trigger a warning
  * `ALARM_TIMEAGO_URGENT` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_URGENT_MINS` (`30`) - minutes since the last reading to trigger a urgent alarm
  * `SHOW_PLUGINS` - enabled plugins that should have their visualizations shown, defaults to all enabled
  * `SHOW_FORECAST` (`ar2`) - plugin forecasts that should be shown by default, supports space delimited values such as `"ar2 openaps"`
  * `LANGUAGE` (`en`) - language of Nightscout. If not available english is used
    * Currently supported language codes are: bg (Български), cs (Čeština), de (Deutsch), dk (Dansk), el (Ελληνικά), en (English), es (Español), fi (Suomi), fr (Français), he (עברית), hr (Hrvatski), it (Italiano), ko (한국어), nb (Norsk (Bokmål)), nl (Nederlands), pl (Polski), pt (Português (Brasil)), ro (Română), ru (Русский), sk (Slovenčina), sv (Svenska), zh_cn (中文（简体)), zh_tw (中文（繁體))
  * `SCALE_Y` (`log`) - The type of scaling used for the Y axis of the charts system wide.
    * The default `log` (logarithmic) option will let you see more detail towards the lower range, while still showing the full CGM range.
    * The `linear` option has equidistant tick marks, the range used is dynamic so that space at the top of chart isn't wasted.
    * The `log-dynamic` is similar to the default `log` options, but uses the same dynamic range and the `linear` scale.
  * `EDIT_MODE` (`on`) - possible values `on` or `off`. Enable or disable icon allowing enter treatments edit mode

### Views

  There are a few alternate web views available that display a simplified BG stream. Append any of these to your Nightscout URL:
  * `/clock.html` - Shows current BG. Grey text on a black background.
  * `/bgclock.html` - Shows current BG, trend arrow, and time of day. Grey text on a black background.
  * `/clock-color.html` - Shows current BG and trend arrow. White text on a background that changes color to indicate current BG threshold (green = in range; blue = below range; yellow = above range; red = urgent below/above).

### Plugins

  Plugins are used extend the way information is displayed, how notifications are sent, alarms are triggered, and more.

  The built-in/example plugins that are available by default are listed below.  The plugins may still need to be enabled by adding to the `ENABLE` environment variable.

#### Default Plugins

  These can be disabled by setting the `DISABLE` env var, for example `DISABLE="direction upbat"`

##### `delta` (BG Delta)
  Calculates and displays the change between the last 2 BG values.

##### `direction` (BG Direction)
  Displays the trend direction.

##### `upbat` (Uploader Battery)
  Displays the most recent battery status from the uploader phone. . Use these [extended setting](#extended-settings) to adjust behavior:
  * `UPBAT_ENABLE_ALERTS` (`false`) - Set to `true` to enable uploader battery alarms via Pushover and IFTTT.
  * `UPBAT_WARN` (`30`) - Minimum battery percent to trigger warning.
  * `UPBAT_URGENT` (`20`) - Minimum battery percent to trigger urgent alarm.

##### `timeago` (Time Ago)
  Displays the time since last CGM entry. Use these [extended setting](#extended-settings) to adjust behavior:
  * `TIMEAGO_ENABLE_ALERTS` (`false`) - Set to `true` to enable stale data alarms via Pushover and IFTTT.
  * `ALARM_TIMEAGO_WARN` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_WARN_MINS` (`15`) - minutes since the last reading to trigger a warning
  * `ALARM_TIMEAGO_URGENT` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_URGENT_MINS` (`30`) - minutes since the last reading to trigger a urgent alarm


##### `devicestatus` (Device Status)
  Used by `upbat` and other plugins to display device status info.  Supports the `DEVICESTATUS_ADVANCED="true"` [extended setting](#extended-settings) to send all device statuses to the client for retrospective use and to support other plugins.

##### `errorcodes` (CGM Error Codes)
  Generates alarms for CGM codes `9` (hourglass) and `10` (???).
  * Use [extended settings](#extended-settings) to adjust what errorcodes trigger notifications and alarms:
    * `ERRORCODES_INFO` (`1 2 3 4 5 6 7 8`) - By default the needs calibration (blood drop) and other codes below 9 generate an info level notification, set to a space separate list of number or `off` to disable
    * `ERRORCODES_WARN` (`off`) - By default there are no warning configured, set to a space separate list of numbers or `off` to disable
    * `ERRORCODES_URGENT` (`9 10`) - By default the hourglass and ??? generate an urgent alarm, set to a space separate list of numbers or `off` to disable

##### `ar2` (AR2 Forecasting)
  Generates alarms based on forecasted values. See [Forecasting using AR2 algorithm](https://github.com/nightscout/nightscout.github.io/wiki/Forecasting)
  * Enabled by default if no thresholds are set **OR** `ALARM_TYPES` includes `predict`.
  * Use [extended settings](#extended-settings) to adjust AR2 behavior:
    * `AR2_CONE_FACTOR` (`2`) - to adjust size of cone, use `0` for a single line.

##### `simplealarms` (Simple BG Alarms)
  Uses `BG_HIGH`, `BG_TARGET_TOP`, `BG_TARGET_BOTTOM`, `BG_LOW` thresholds to generate alarms.
  * Enabled by default if 1 of these thresholds is set **OR** `ALARM_TYPES` includes `simple`.

##### `profile` (Treatment Profile)
  Add link to Profile Editor and allow to enter treatment profile settings. Also uses the extended setting:
  * `PROFILE_HISTORY` (`off`) - possible values `on` or `off`. Enable/disable NS ability to keep history of your profiles (still experimental)
  * `PROFILE_MULTIPLE` (`off`) - possible values `on` or `off`. Enable/disable NS ability to handle and switch between multiple treatment profiles

#### Advanced Plugins:

##### `careportal` (Careportal)
  An optional form to enter treatments.

##### `boluscalc` (Bolus Wizard)

##### `food` (Custom Foods)
  An option plugin to enable adding foods from database in Bolus Wizard and enable .

##### `rawbg` (Raw BG)
  Calculates BG using sensor and calibration records from and displays an alternate BG values and noise levels.

##### `iob` (Insulin-on-Board)
  Adds the IOB pill visualization in the client and calculates values that used by other plugins.  Uses treatments with insulin doses and the `dia` and `sens` fields from the [treatment profile](#treatment-profile).

##### `cob` (Carbs-on-Board)
  Adds the COB pill visualization in the client and calculates values that used by other plugins.  Uses treatments with carb doses and the `carbs_hr`, `carbratio`, and `sens` fields from the [treatment profile](#treatment-profile).

##### `bwp` (Bolus Wizard Preview)
  This plugin in intended for the purpose of automatically snoozing alarms when the CGM indicates high blood sugar but there is also insulin on board (IOB) and secondly, alerting to user that it might be beneficial to measure the blood sugar using a glucometer and dosing insulin as calculated by the pump or instructed by trained medicare professionals. ***The values provided by the plugin are provided as a reference based on CGM data and insulin sensitivity you have configured, and are not intended to be used as a reference for bolus calculation.*** The plugin calculates the bolus amount when above your target, generates alarms when you should consider checking and bolusing, and snoozes alarms when there is enough IOB to cover a high BG. Uses the results of the `iob` plugin and `sens`, `target_high`, and `target_low` fields from the [treatment profile](#treatment-profile). Defaults that can be adjusted with [extended setting](#extended-settings)
  * `BWP_WARN` (`0.50`) - If `BWP` is > `BWP_WARN` a warning alarm will be triggered.
  * `BWP_URGENT` (`1.00`) - If `BWP` is > `BWP_URGENT` an urgent alarm will be triggered.
  * `BWP_SNOOZE_MINS` (`10`) - minutes to snooze when there is enough IOB to cover a high BG.
  * `BWP_SNOOZE` - (`0.10`) If BG is higher then the `target_high` and `BWP` < `BWP_SNOOZE` alarms will be snoozed for `BWP_SNOOZE_MINS`.

##### `cage` (Cannula Age)
  Calculates the number of hours since the last `Site Change` treatment that was recorded.
  * `CAGE_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications to remind you of upcoming cannula change.
  * `CAGE_INFO` (`44`) - If time since last `Site Change` matches `CAGE_INFO`, user will be warned of upcoming cannula change
  * `CAGE_WARN` (`48`) - If time since last `Site Change` matches `CAGE_WARN`, user will be alarmed to to change the cannula
  * `CAGE_URGENT` (`72`) - If time since last `Site Change` matches `CAGE_URGENT`, user will be issued a persistent warning of overdue change.
  * `CAGE_DISPLAY` (`hours`) - Possible values are 'hours' or 'days'. If 'days' is selected and age of canula is greater than 24h number is displayed in days and hours

#####  `sage` (Sensor Age)
  Calculates the number of days and hours since the last `Sensor Start` and `Sensor Change` treatment that was recorded.
  * `SAGE_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications to remind you of upcoming sensor change.
  * `SAGE_INFO` (`144`) - If time since last sensor event matches `SAGE_INFO`, user will be warned of upcoming sensor change
  * `SAGE_WARN` (`164`) - If time since last sensor event matches `SAGE_WARN`, user will be alarmed to to change/restart the sensor
  * `SAGE_URGENT` (`166`) - If time since last sensor event matches `SAGE_URGENT`, user will be issued a persistent warning of overdue change.

##### `iage` (Insulin Age)
  Calculates the number of days and hours since the last `Insulin Change` treatment that was recorded.
  * `IAGE_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications to remind you of upcoming insulin reservoir change.
  * `IAGE_INFO` (`44`) - If time since last `Insulin Change` matches `IAGE_INFO`, user will be warned of upcoming insulin reservoir change
  * `IAGE_WARN` (`48`) - If time since last `Insulin Change` matches `IAGE_WARN`, user will be alarmed to to change the insulin reservoir
  * `IAGE_URGENT` (`72`) - If time since last `Insulin Change` matches `IAGE_URGENT`, user will be issued a persistent warning of overdue change.

##### `treatmentnotify` (Treatment Notifications)
  Generates notifications when a treatment has been entered and snoozes alarms minutes after a treatment.  Default snooze is 10 minutes, and can be set using the `TREATMENTNOTIFY_SNOOZE_MINS` [extended setting](#extended-settings).

##### `basal` (Basal Profile)
  Adds the Basal pill visualization to display the basal rate for the current time.  Also enables the `bwp` plugin to calculate correction temp basal suggestions.  Uses the `basal` field from the [treatment profile](#treatment-profile). Also uses the extended setting:
  * `BASAL_RENDER` (`none`) - Possible values are `none`, `default`, or `icicle` (inverted)

##### `bridge` (Share2Nightscout bridge)
  Glucose reading directly from the Share service, uses these extended settings:
  * `BRIDGE_USER_NAME` - Your user name for the Share service.
  * `BRIDGE_PASSWORD` - Your password for the Share service.
  * `BRIDGE_INTERVAL` (`150000` *2.5 minutes*) - The time to wait between each update.
  * `BRIDGE_MAX_COUNT` (`1`) - The maximum number of records to fetch per update.
  * `BRIDGE_FIRST_FETCH_COUNT` (`3`) - Changes max count during the very first update only.
  * `BRIDGE_MAX_FAILURES` (`3`) - How many failures before giving up.
  * `BRIDGE_MINUTES` (`1400`) - The time window to search for new data per update (default is one day in minutes).

##### `mmconnect` (MiniMed Connect bridge)
  Transfer real-time MiniMed Connect data from the Medtronic CareLink server into Nightscout ([read more](https://github.com/mddub/minimed-connect-to-nightscout))
  * `MMCONNECT_USER_NAME` - Your user name for CareLink Connect.
  * `MMCONNECT_PASSWORD` - Your password for CareLink Connect.
  * `MMCONNECT_INTERVAL` (`60000` *1 minute*) - Number of milliseconds to wait between requests to the CareLink server.
  * `MMCONNECT_MAX_RETRY_DURATION` (`32`) - Maximum number of total seconds to spend retrying failed requests before giving up.
  * `MMCONNECT_SGV_LIMIT` (`24`) - Maximum number of recent sensor glucose values to send to Nightscout on each request.
  * `MMCONNECT_VERBOSE` - Set this to "true" to log CareLink request information to the console.
  * `MMCONNECT_STORE_RAW_DATA` - Set this to "true" to store raw data returned from CareLink as `type: "carelink_raw"` database entries (useful for development).

##### `pump` (Pump Monitoring)
  Generic Pump Monitoring for OpenAPS, MiniMed Connect, RileyLink, t:slim, with more on the way
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `PUMP_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications for Pump battery and reservoir.
  * `PUMP_WARN_ON_SUSPEND` (`false`) - Set to `true` to get an alarm when the pump is suspended.
  * `PUMP_FIELDS` (`reservoir battery`) - The fields to display by default.  Any of the following fields: `reservoir`, `battery`, `clock`, `status`, and `device`
  * `PUMP_RETRO_FIELDS` (`reservoir battery clock`) - The fields to display in retro mode. Any of the above fields.
  * `PUMP_WARN_CLOCK` (`30`) - The number of minutes ago that needs to be exceed before an alert is triggered.
  * `PUMP_URGENT_CLOCK` (`60`) - The number of minutes ago that needs to be exceed before an urgent alarm is triggered.
  * `PUMP_WARN_RES` (`10`) - The number of units remaining, a warning will be triggered when dropping below this threshold.
  * `PUMP_URGENT_RES` (`5`) - The number of units remaining, an urgent alarm will be triggered when dropping below this threshold.
  * `PUMP_WARN_BATT_P` (`30`) - The % of the pump battery remaining, a warning will be triggered when dropping below this threshold.
  * `PUMP_URGENT_BATT_P` (`20`) - The % of the pump battery remaining, an urgent alarm will be triggered when dropping below this threshold.
  * `PUMP_WARN_BATT_V` (`1.35`) - The voltage (if percent isn't available) of the pump battery, a warning will be triggered when dropping below this threshold.
  * `PUMP_URGENT_BATT_V` (`1.30`) - The  voltage (if percent isn't available) of the pump battery, an urgent alarm will be triggered when dropping below this threshold.

##### `openaps` (OpenAPS)
  Integrated OpenAPS loop monitoring, uses these extended settings:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `OPENAPS_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications when OpenAPS isn't looping.  If OpenAPS is going to offline for a period of time, you can add an `OpenAPS Offline` event for the expected duration from Careportal to avoid getting alerts.
  * `OPENAPS_WARN` (`30`) - The number of minutes since the last loop that needs to be exceed before an alert is triggered
  * `OPENAPS_URGENT` (`60`) - The number of minutes since the last loop that needs to be exceed before an urgent alarm is triggered
  * `OPENAPS_FIELDS` (`status-symbol status-label iob meal-assist rssi`) - The fields to display by default.  Any of the following fields: `status-symbol`, `status-label`, `iob`, `meal-assist`, `freq`, and `rssi`
  * `OPENAPS_RETRO_FIELDS` (`status-symbol status-label iob meal-assist rssi`) - The fields to display in retro mode. Any of the above fields.

 Also see [Pushover](#pushover) and [IFTTT Maker](#ifttt-maker).

##### `loop` (Loop)
  iOS Loop app monitoring, uses these extended settings:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `LOOP_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications when Loop isn't looping.
  * `LOOP_WARN` (`30`) - The number of minutes since the last loop that needs to be exceeded before an alert is triggered
  * `LOOP_URGENT` (`60`) - The number of minutes since the last loop that needs to be exceeded before an urgent alarm is triggered
  * Add `loop` to `SHOW_FORECAST` to show forecasted BG.

##### `xdrip-js` (xDrip-js)
  Integrated xDrip-js monitoring, uses these extended settings:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `XDRIP-JS_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications when CGM state is not OK or battery voltages fall below threshold.
  * `XDRIP-JS_STATE_NOTIFY_INTRVL` (`0.5`) - Set to number of hours between CGM state notifications
  * `XDRIP-JS_WARN_BAT_V` (`300`) - The voltage of either transmitter battery, a warning will be triggered when dropping below this threshold.

##### `alexa` (Amazon Alexa)
  Integration with Amazon Alexa, [detailed setup instructions](lib/plugins/alexa-plugin.md)

##### `speech` (Speech)
  Speech synthesis plugin. When enabled, speaks out the blood glucose values, IOB and alarms. Note you have to set the LANGUAGE setting on the server to get all translated alarms.

##### `cors` (CORS)
  Enabled [CORS](https://en.wikipedia.org/wiki/Cross-origin_resource_sharing) so other websites can make request to your Nightscout site, uses these extended settings:
  * `CORS_ALLOW_ORIGIN` (`*`) - The list of sites that are allow to make requests

#### Extended Settings
  Some plugins support additional configuration using extra environment variables.  These are prefixed with the name of the plugin and a `_`.  For example setting `MYPLUGIN_EXAMPLE_VALUE=1234` would make `extendedSettings.exampleValue` available to the `MYPLUGIN` plugin.

  Plugins only have access to their own extended settings, all the extended settings of client plugins will be sent to the browser.
  
  * `DEVICESTATUS_ADVANCED` (`true`) - Defaults to true. Users who only have a single device uploading data to Nightscout can set this to false to reduce the data use of the site.

#### Pushover
  In addition to the normal web based alarms, there is also support for [Pushover](https://pushover.net/) based alarms and notifications.

  To get started install the Pushover application on your iOS or Android device and create an account.

  Using that account login to [Pushover](https://pushover.net/), in the top left you’ll see your User Key, you’ll need this plus an application API Token/Key to complete this setup.

  You’ll need to [Create a Pushover Application](https://pushover.net/apps/build).  You only need to set the Application name, you can ignore all the other settings, but setting an Icon is a nice touch.  Maybe you'd like to use [this one](https://raw.githubusercontent.com/nightscout/cgm-remote-monitor/master/static/images/large.png)?

  Pushover is configured using the following Environment Variables:

    * `ENABLE` - `pushover` should be added to the list of plugin, for example: `ENABLE="pushover"`.
    * `PUSHOVER_API_TOKEN` - Used to enable pushover notifications, this token is specific to the application you create from in [Pushover](https://pushover.net/), ***[additional pushover information](#pushover)*** below.
    * `PUSHOVER_USER_KEY` - Your Pushover user key, can be found in the top left of the [Pushover](https://pushover.net/) site, this can also be a pushover delivery group key to send to a group rather than just a single user.  This also supports a space delimited list of keys.  To disable `INFO` level pushes set this to `off`.
    * `PUSHOVER_ALARM_KEY` - An optional Pushover user/group key, will be used for system wide alarms (level > `WARN`).  If not defined this will fallback to `PUSHOVER_USER_KEY`.  A possible use for this is sending important messages and alarms to a CWD that you don't want to send all notification too.  This also support a space delimited list of keys.  To disable Alarm pushes set this to `off`.
    * `PUSHOVER_ANNOUNCEMENT_KEY` - An optional Pushover user/group key, will be used for system wide user generated announcements.  If not defined this will fallback to `PUSHOVER_USER_KEY` or `PUSHOVER_ALARM_KEY`.  This also support a space delimited list of keys. To disable Announcement pushes set this to `off`.
    * `BASE_URL` - Used for pushover callbacks, usually the URL of your Nightscout site, use https when possible.
    * `API_SECRET` - Used for signing the pushover callback request for acknowledgments.

    If you never want to get info level notifications (treatments) use `PUSHOVER_USER_KEY="off"`
    If you never want to get an alarm via pushover use `PUSHOVER_ALARM_KEY="off"`
    If you never want to get an announcement via pushover use `PUSHOVER_ANNOUNCEMENT_KEY="off"`

    If only `PUSHOVER_USER_KEY` is set it will be used for all info notifications, alarms, and announcements

    For testing/development try [localtunnel](http://localtunnel.me/).

#### IFTTT Maker
 In addition to the normal web based alarms, and pushover, there is also integration for [IFTTT Maker](https://ifttt.com/maker).

 With Maker you are able to integrate with all the other [IFTTT Channels](https://ifttt.com/channels).  For example you can send a tweet when there is an alarm, change the color of hue light, send an email, send and sms, and so much more.

 1. Setup IFTTT account: [login](https://ifttt.com/login) or [create an account](https://ifttt.com/join)
 2. Find your secret key on the [maker page](https://ifttt.com/maker)
 3. Configure Nightscout by setting these environment variables:
  * `ENABLE` - `maker` should be added to the list of plugin, for example: `ENABLE="maker"`.
  * `MAKER_KEY` - Set this to your secret key that you located in step 2, for example: `MAKER_KEY="abcMyExampleabc123defjt1DeNSiftttmak-XQb69p"` This also support a space delimited list of keys.
  * `MAKER_ANNOUNCEMENT_KEY` - An optional Maker key, will be used for system wide user generated announcements.  If not defined this will fallback to `MAKER_KEY`.  A possible use for this is sending important messages and alarms to a CWD that you don't want to send all notification too.  This also support a space delimited list of keys.
 4. [Create a recipe](https://ifttt.com/myrecipes/personal/new) or see [more detailed instructions](lib/plugins/maker-setup.md#create-a-recipe)

 Plugins can create custom events, but all events sent to maker will be prefixed with `ns-`.  The core events are:
  * `ns-event` - This event is sent to the maker service for all alarms and notifications.  This is good catch all event for general logging.
  * `ns-allclear` - This event is sent to the maker service when an alarm has been ack'd or when the server starts up without triggering any alarms.  For example, you could use this event to turn a light to green.
  * `ns-info` - Plugins that generate notifications at the info level will cause this event to also be triggered.  It will be sent in addition to `ns-event`.
  * `ns-warning` - Alarms at the warning level with cause this event to also be triggered.  It will be sent in addition to `ns-event`.
  * `ns-urgent` - Alarms at the urgent level with cause this event to also be triggered.  It will be sent in addition to `ns-event`.
  * see the [full list of events](lib/plugins/maker-setup.md#events)


### Treatment Profile
  Some of the [plugins](#plugins) make use of a treatment profile that can be edited using the Profile Editor, see the link in the Settings drawer on your site.

  Treatment Profile Fields:

  * `timezone` (Time Zone) - time zone local to the patient. *Should be set.*
  * `units` (Profile Units) - blood glucose units used in the profile, either "mgdl" or "mmol"
  * `dia` (Insulin duration) - value should be the duration of insulin action to use in calculating how much insulin is left active. Defaults to 3 hours.
  * `carbs_hr` (Carbs per Hour) - The number of carbs that are processed per hour, for more information see [#DIYPS](http://diyps.org/2014/05/29/determining-your-carbohydrate-absorption-rate-diyps-lessons-learned/).
  * `carbratio` (Carb Ratio) - grams per unit of insulin.
  * `sens` (Insulin sensitivity) How much one unit of insulin will normally lower blood glucose.
  * `basal` The basal rate set on the pump.
  * `target_high` - Upper target for correction boluses.
  * `target_low` - Lower target for correction boluses.

  Some example profiles are [here](example-profiles.md).

## Setting environment variables
Easy to emulate on the commandline:

```bash
    echo 'MONGO_CONNECTION=mongodb://sally:sallypass@ds099999.mongolab.com:99999/nightscout' >> my.env
    echo 'MONGO_COLLECTION=entries' >> my.env
```

From now on you can run using
```bash
    $ (eval $(cat my.env | sed 's/^/export /') && PORT=1337 node server.js)
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
    Copyright (C) 2017 Nightscout contributors.  See the COPYRIGHT file
    at the root directory of this distribution and at
    https://github.com/nightscout/cgm-remote-monitor/blob/master/COPYRIGHT

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
