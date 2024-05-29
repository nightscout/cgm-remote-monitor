Nightscout Web Monitor (a.k.a. cgm-remote-monitor)
==================================================

![nightscout horizontal](https://cloud.githubusercontent.com/assets/751143/8425633/93c94dc0-1ebc-11e5-99e7-71a8f464caac.png)

[![Build Status][build-img]][build-url]
[![Dependency Status][dependency-img]][dependency-url]
[![Coverage Status][coverage-img]][coverage-url]
[![Codacy Badge][codacy-img]][codacy-url]
[![Discord chat][discord-img]][discord-url]

This acts as a web-based CGM (Continuous Glucose Monitor) to allow
multiple caregivers to remotely view a patient's glucose data in
real time.  The server reads a MongoDB which is intended to be data
from a physical CGM, where it sends new SGV (sensor glucose values) as
the data becomes available.  The data is then displayed graphically
and blood glucose values are predicted 0.5 hours ahead using an
autoregressive second order model.  Alarms are generated for high and
low values, which can be cleared by any watcher of the data.

# Looking for documentation?

## End user?

Nightscout documentation is currently split to two locations. This page lists all the configuration options in
Nightscout and is useful for users who've already gone through the installation process. IF you're looking
for the documentation that looks like it's written for non-programmers, that's located at [nightscout.github.io](https://nightscout.github.io/).

Older documentation is available at [nightscout.info](http://nightscout.info).

## Developer?

See [CONTRIBUTING.md](CONTRIBUTING.md)

## [#WeAreNotWaiting](https://twitter.com/hashtag/wearenotwaiting?src=hash&vertical=default&f=images) and [this](https://vimeo.com/109767890) is why.

[![Coverage Status](https://coveralls.io/repos/github/nightscout/cgm-remote-monitor/badge.svg?branch=master)](https://coveralls.io/github/nightscout/cgm-remote-monitor?branch=master)

[build-img]: https://img.shields.io/travis/nightscout/cgm-remote-monitor.svg
[build-url]: https://travis-ci.org/nightscout/cgm-remote-monitor
[dependency-img]: https://img.shields.io/david/nightscout/cgm-remote-monitor.svg
[dependency-url]: https://david-dm.org/nightscout/cgm-remote-monitor
[coverage-img]: https://img.shields.io/coveralls/nightscout/cgm-remote-monitor/dev.svg
[coverage-url]: https://coveralls.io/github/nightscout/cgm-remote-monitor?branch=master
[codacy-img]: https://www.codacy.com/project/badge/f79327216860472dad9afda07de39d3b
[codacy-url]: https://www.codacy.com/app/Nightscout/cgm-remote-monitor
[discord-img]: https://img.shields.io/discord/629952586895851530?label=discord%20chat
[discord-url]: https://discord.gg/rTKhrqz
[heroku-img]: https://www.herokucdn.com/deploy/button.png
[heroku-url]: https://heroku.com/deploy?template=https://github.com/nightscout/cgm-remote-monitor
[update-img]: docs/update.png
[update-fork]: http://nightscout.github.io/pages/update-fork/
[original]: https://github.com/rnpenguin/cgm-remote-monitor


<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Install](#install)
  - [Supported configurations:](#supported-configurations)
  - [Recommended minimum browser versions for using Nightscout:](#recommended-minimum-browser-versions-for-using-nightscout)
  - [Windows installation software requirements:](#windows-installation-software-requirements)
  - [Installation notes for users with nginx or Apache reverse proxy for SSL/TLS offloading:](#installation-notes-for-users-with-nginx-or-apache-reverse-proxy-for-ssltls-offloading)
  - [Installation notes for Microsoft Azure, Windows:](#installation-notes-for-microsoft-azure-windows)
- [Development](#development)
- [Usage](#usage)
  - [Updating my version?](#updating-my-version)
  - [Configure my uploader to match](#configure-my-uploader-to-match)
  - [Nightscout API](#nightscout-api)
      - [Example Queries](#example-queries)
  - [Environment](#environment)
    - [Required](#required)
    - [Features](#features)
    - [Alarms](#alarms)
    - [Core](#core)
    - [Predefined values for your browser settings (optional)](#predefined-values-for-your-browser-settings-optional)
    - [Predefined values for your server settings (optional)](#predefined-values-for-your-server-settings-optional)
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
      - [Advanced Plugins:](#advanced-plugins)
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
        - [`bage` (Battery Age)](#bage-battery-age)
        - [`treatmentnotify` (Treatment Notifications)](#treatmentnotify-treatment-notifications)
        - [`basal` (Basal Profile)](#basal-basal-profile)
        - [`bolus` (Bolus Rendering)](#bolus-bolus-rendering)
        - [`connect` (Nightscout Connect)](#connect-nightscout-connect)
        - [`bridge` (Share2Nightscout bridge)](#bridge-share2nightscout-bridge), _deprecated_
        - [`mmconnect` (MiniMed Connect bridge)](#mmconnect-minimed-connect-bridge), _deprecated_
        - [`pump` (Pump Monitoring)](#pump-pump-monitoring)
        - [`openaps` (OpenAPS)](#openaps-openaps)
        - [`loop` (Loop)](#loop-loop)
        - [`override` (Override Mode)](#override-override-mode)
        - [`xdripjs` (xDrip-js)](#xdripjs-xdrip-js)
        - [`alexa` (Amazon Alexa)](#alexa-amazon-alexa)
        - [`googlehome` (Google Home/DialogFLow)](#googlehome-google-homedialogflow)
        - [`speech` (Speech)](#speech-speech)
        - [`cors` (CORS)](#cors-cors)
      - [Extended Settings](#extended-settings)
      - [Pushover](#pushover)
      - [IFTTT Maker](#ifttt-maker)
    - [Treatment Profile](#treatment-profile)
  - [Setting environment variables](#setting-environment-variables)
    - [Vagrant install](#vagrant-install)
  - [More questions?](#more-questions)
    - [Browser testing suite provided by](#browser-testing-suite-provided-by)
  - [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Install

## Supported configurations:

- [Nightscout Setup](https://nightscout.github.io/nightscout/new_user/) (recommended)

While you can install Nightscout on a virtual server or a Raspberry Pi, we do not recommend this unless you have at least some
experience hosting Node applications and development using the toolchain in use with Nightscout.

If you're a hosting provider and want to provide our users additional hosting options,
you're welcome to issue a documentation pull request with instructions on how to setup Nightscout on your system.

## Recommended minimum browser versions for using Nightscout:

Our [browserslist](https://github.com/browserslist/browserslist) policy is documented in `.browserlistrc`.   
We currently support approximately [91%](https://browsersl.ist/?q=%3E+0.25%25%2C+ios_saf+9.3%2C+ios_saf+10.3%2C+ios_saf+13.7%2C+ios_saf+14.8%2C+not+dead%2C+not+and_uc+12.12%2C+not+ie+11%0A) of all browsers globally used. These include:

- Android Chrome: 104 or later (`and_chr`)
- Google Chrome: 101 or later (`chrome`)
- Microsoft Edge: 103 or later (`edge`)
- Mozilla Firefox: 102 or later (`firefox`)
- Apple Safari on iOS: 15.5 or later (`ios_saf`)
- Opera Mini on Android: 63 or later (`op_mini`)
- Opera: 88 or later (`opera`)
- Apple Safari for macOS 10.15 Catalina or later: : 15.5 or later (`safari`)
- Samsung Internet on Android: 17.0 or later (`samsung`)
- Internet Explorer 11 : not supported

Older versions or other browsers might work, but are untested and unsupported. We'll try to to keep Nightscout compatible with older iPads (e.g. Safari on iOS 10.3.4), but note that those devices are not supported by Apple anymore and have known security issues. Debugging these old devices gets harder due to Apple not supporting debugging the old devices on Macs that have been updated. Some features may not work with devices/browsers on the older end of these requirements.



## Installation software requirements:

- [Node.js](http://nodejs.org/) Latest Node v14 or v16 LTS. Node versions that do not have the latest security patches will not be supported. Use [Install instructions for Node](https://nodejs.org/en/download/package-manager/) or use `bin/setup.sh`)
- [MongoDB](https://www.mongodb.com/download-center?jmp=nav#community) 4.2 or 4.4.

As a non-root user clone this repo then install dependencies into the root of the project:

```bash
$ npm install
```

## Installation notes for users with nginx or Apache reverse proxy for SSL/TLS offloading:

- Your site redirects insecure connections to `https` by default. If you use a reverse proxy like nginx or Apache to handle the connection security for you, make sure it sets the `X-Forwarded-Proto` header. Otherwise nightscout will be unable to know if it was called through a secure connection and will try to redirect you to the https version. If you're unable to set this Header, you can change the `INSECURE_USE_HTTP` setting in nightscout to true in order to allow insecure connections without being redirected.
- In case you use a proxy. Do not use an external network interfaces for hosting Nightscout. Make sure the unsecure port is not available from a remote network connection
- HTTP Strict Transport Security (HSTS) headers are enabled by default, use settings `SECURE_HSTS_HEADER` and `SECURE_HSTS_HEADER_*`
- See [Predefined values for your server settings](#predefined-values-for-your-server-settings-optional) for more details

## Installation notes for Microsoft Azure, Windows:

- If deploying the software to Microsoft Azure, you must set ** in the app settings for *WEBSITE_NODE_DEFAULT_VERSION* and *SCM_COMMAND_IDLE_TIMEOUT* **before** you deploy the latest Nightscout or the site deployment will likely fail. Other hosting environments do not require this setting. Additionally, if using the Azure free hosting tier, the installation might fail due to resource constraints imposed by Azure on the free hosting. Please set the following settings to the environment in Azure:
```
WEBSITE_NODE_DEFAULT_VERSION=16.16.0
SCM_COMMAND_IDLE_TIMEOUT=300
```
- See [install MongoDB, Node.js, and Nightscouton a single Windows system](https://github.com/jaylagorio/Nightscout-on-Windows-Server). if you want to host your Nightscout outside of the cloud. Although the instructions are intended for Windows Server the procedure is compatible with client versions of Windows such as Windows 7 and Windows 10.
- If you deploy to Windows and want to develop or test you need to install [Cygwin](https://www.cygwin.com/) (use [setup-x86_64.exe](https://www.cygwin.com/setup-x86_64.exe) and make sure to install `build-essential` package. Test your configuration by executing `make` and check if all tests are ok.

# Development

Want to help with development, or just see how Nightscout works? Great! See [CONTRIBUTING.md](CONTRIBUTING.md) for development-related documentation.

# Usage

The data being uploaded from the server to the client is from a MongoDB server such as [MongoDB Atlas][https://www.mongodb.com].

[autoconfigure]: https://nightscout.github.io/pages/configure/
[mongostring]: https://nightscout.github.io/pages/mongostring/

## Updating my version?

The easiest way to update your version of cgm-remote-monitor to the latest version is to use the [update tool][update-fork]. A step-by-step guide is available [here][http://www.nightscout.info/wiki/welcome/how-to-update-to-latest-cgm-remote-monitor-aka-cookie].
To downgrade to an older version, follow [this guide][http://www.nightscout.info/wiki/welcome/how-to-deploy-an-older-version-of-nightscout].

## Configure my uploader to match

Use the [autoconfigure tool][autoconfigure] to sync an uploader to your config.

## Nightscout API

The Nightscout API enables direct access to your data without the need for Mongo access.
You can find CGM data in `/api/v1/entries`, Care Portal Treatments in `/api/v1/treatments`, and Treatment Profiles in `/api/v1/profile`.
The server status and settings are available from `/api/v1/status.json`.

By default the `/entries` and `/treatments` APIs limit results to the the most recent 10 values from the last 2 days.
You can get many more results, by using the `count`, `date`, `dateString`, and `created_at` parameters, depending on the type of data you're looking for.

Once you've installed Nightscout, you can access API documentation by loading `/api-docs/` URL in your instance.

#### Example Queries

(replace `http://localhost:1337` with your own URL)

  * 100's: `http://localhost:1337/api/v1/entries.json?find[sgv]=100`
  * Count of 100's in a month: `http://localhost:1337/api/v1/count/entries/where?find[dateString][$gte]=2016-09&find[dateString][$lte]=2016-10&find[sgv]=100`
  * BGs between 2 days: `http://localhost:1337/api/v1/entries/sgv.json?find[dateString][$gte]=2015-08-28&find[dateString][$lte]=2015-08-30`
  * Juice Box corrections in a year: `http://localhost:1337/api/v1/treatments.json?count=1000&find[carbs]=15&find[eventType]=Carb+Correction&find[created_at][$gte]=2015`
  * Boluses over 2U: `http://localhost:1337/api/v1/treatments.json?find[insulin][$gte]=2`

The API is Swagger enabled, so you can generate client code to make working with the API easy.
To learn more about the Nightscout API, visit https://YOUR-SITE.com/api-docs/ or review [swagger.yaml](lib/server/swagger.yaml).

## Environment

`VARIABLE` (default) - description

### Required

  * `MONGODB_URI` - The connection string for your Mongo database. Something like `mongodb://sally:sallypass@ds099999.mongolab.com:99999/nightscout`.
  * `API_SECRET` - A secret passphrase that must be at least 12 characters long.
  * `MONGODB_COLLECTION` (`entries`) - The Mongo collection where CGM entries are stored.
  * `DISPLAY_UNITS` (`mg/dl`) - Options are `mg/dl` or `mmol/L` (or just `mmol`).  Setting to `mmol/L` puts the entire server into `mmol/L` mode by default, no further settings needed.

### Features

  * `ENABLE` - Used to enable optional features, expects a space delimited list, such as: `careportal rawbg iob`, see [plugins](#plugins) below
  * `DISABLE` - Used to disable default features, expects a space delimited list, such as: `direction upbat`, see [plugins](#plugins) below
  * `BASE_URL` - Used for building links to your site's API, i.e. Pushover callbacks, usually the URL of your Nightscout site.
  * `AUTH_DEFAULT_ROLES` (`readable`) - possible values `readable`, `denied`, or any valid role
    name.  When `readable`, anyone can view Nightscout without a token.
    Setting it to `denied` will require a token from every visit, using `status-only` will enable api-secret based login.
  * `IMPORT_CONFIG` - Used to import settings and extended settings from a url such as a gist.  Structure of file should be something like: `{"settings": {"theme": "colors"}, "extendedSettings": {"upbat": {"enableAlerts": true}}}`
  * `TREATMENTS_AUTH` (`on`) - possible values `on` or `off`. Deprecated, if set to `off` the `careportal` role will be added to `AUTH_DEFAULT_ROLES`

#### Data Rights

These are useful to help protect your rights to portability and
autonomy for your data:
  * `OBSCURED` - list, identical to `ENABLE`, a list of plugins to
    obscure.
  * `OBSCURE_DEVICE_PROVENANCE` - Required, a string visible to the [companies deciding to filter based on your data](https://help.sugarmate.io/en/articles/4673402-adding-a-nightscout-data-source).  For example, `my-data-rights`.

### Alarms

  These alarm setting affect all delivery methods (browser, Pushover, IFTTT, etc.). Values and settings entered here will be the defaults for new browser views, but will be overridden if different choices are made in the settings UI.

  * `ALARM_TYPES` (`simple` if any `BG_`* ENV's are set, otherwise `predict`) - currently 2 alarm types are supported, and can be used independently or combined.  The `simple` alarm type only compares the current BG to `BG_` thresholds above, the `predict` alarm type uses highly tuned formula that forecasts where the BG is going based on it's trend.  `predict` **DOES NOT** currently use any of the `BG_`* ENV's
  * `BG_HIGH` (`260`) - the high BG outside the target range that is considered urgent (interprets units based on DISPLAY_UNITS setting)
  * `BG_TARGET_TOP` (`180`) - the top of the target range, also used to draw the line on the chart (interprets units based on DISPLAY_UNITS setting)
  * `BG_TARGET_BOTTOM` (`80`) - the bottom of the target range, also used to draw the line on the chart (interprets units based on DISPLAY_UNITS setting)
  * `BG_LOW` (`55`) - the low BG outside the target range that is considered urgent (interprets units based on DISPLAY_UNITS setting)
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

  * `MONGO_TREATMENTS_COLLECTION` (`treatments`) -The collection used to store treatments entered in the Care Portal, see the `ENABLE` env var above
  * `MONGO_DEVICESTATUS_COLLECTION`(`devicestatus`) - The collection used to store device status information such as uploader battery
  * `MONGO_PROFILE_COLLECTION`(`profile`) - The collection used to store your profiles
  * `MONGO_FOOD_COLLECTION`(`food`) - The collection used to store your food database
  * `MONGO_ACTIVITY_COLLECTION`(`activity`) - The collection used to store activity data
  * `PORT` (`1337`) - The port that the node.js application will listen on.
  * `HOSTNAME` - The hostname that the node.js application will listen on, null by default for any hostname for IPv6 you may need to use `::`.
  * `SSL_KEY` - Path to your ssl key file, so that ssl(https) can be enabled directly in node.js. If using Let's Encrypt, make this variable the path to your privkey.pem file (private key).
  * `SSL_CERT` - Path to your ssl cert file, so that ssl(https) can be enabled directly in node.js. If using Let's Encrypt, make this variable the path to fullchain.pem file (cert + ca).
  * `SSL_CA` - Path to your ssl ca file, so that ssl(https) can be enabled directly in node.js. If using Let's Encrypt, make this variable the path to chain.pem file (chain).
  * `HEARTBEAT` (`60`)  - Number of seconds to wait in between database checks
  * `DEBUG_MINIFY` (`true`)  - Debug option, setting to `false` will disable bundle minification to help tracking down error and speed up development
  * `DE_NORMALIZE_DATES`(`true`) - The Nightscout REST API normalizes all entered dates to UTC zone. Some Nightscout clients have broken date deserialization logic and expect to received back dates in zoned formats. Setting this variable to `true` causes the REST API to serialize dates sent to Nightscout in zoned format back to zoned format when served to clients over REST.

### Predefined values for your browser settings (optional)

  * `TIME_FORMAT` (`12`)- possible values `12` or `24`
  * `DAY_START` (`7.0`) - time for start of day (0.0 - 24.0) for features using day time / night time options
  * `DAY_END` (`21.0`) - time for end of day (0.0 - 24.0) for features using day time / night time options
  * `NIGHT_MODE` (`off`) - possible values `on` or `off`
  * `SHOW_RAWBG` (`never`) - possible values `always`, `never` or `noise`
  * `CUSTOM_TITLE` (`Nightscout`) - Title for the main view
  * `THEME` (`colors`) - possible values `default`, `colors`, or `colorblindfriendly`
  * `ALARM_TIMEAGO_WARN` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_WARN_MINS` (`15`) - minutes since the last reading to trigger a warning
  * `ALARM_TIMEAGO_URGENT` (`on`) - possible values `on` or `off`
  * `ALARM_TIMEAGO_URGENT_MINS` (`30`) - minutes since the last reading to trigger a urgent alarm
  * `SHOW_PLUGINS` - enabled plugins that should have their visualizations shown, defaults to all enabled
  * `SHOW_FORECAST` (`ar2`) - plugin forecasts that should be shown by default, supports space delimited values such as `"ar2 openaps"`
  * `LANGUAGE` (`en`) - language of Nightscout. If not available english is used
    * Currently supported language codes are: bg (Български), cs (Čeština), de (Deutsch), dk (Dansk), el (Ελληνικά), en (English), es (Español), fi (Suomi), fr (Français), he (עברית), hr (Hrvatski), hu (magyar), it (Italiano), ko (한국어), nb (Norsk (Bokmål)), nl (Nederlands), pl (Polski), pt (Português (Brasil)), ro (Română), ru (Русский), sk (Slovenčina), sv (Svenska), tr (Turkish), zh_cn (中文（简体)), zh_tw (中文（繁體))
  * `SCALE_Y` (`log`) - The type of scaling used for the Y axis of the charts system wide.
    * The default `log` (logarithmic) option will let you see more detail towards the lower range, while still showing the full CGM range.
    * The `linear` option has equidistant tick marks; the range used is dynamic so that space at the top of chart isn't wasted.
    * The `log-dynamic` is similar to the default `log` options, but uses the same dynamic range and the `linear` scale.
  * `EDIT_MODE` (`on`) - possible values `on` or `off`. Enables the icon allowing for editing of treatments in the main view.

### Predefined values for your server settings (optional)
  * `INSECURE_USE_HTTP` (`false`) - Redirect unsafe http traffic to https. Possible values `false`, or `true`. Your site redirects to `https` by default. If you don't want that from Nightscout, but want to implement that with a Nginx or Apache proxy, set `INSECURE_USE_HTTP` to `true`. Note: This will allow (unsafe) http traffic to your Nightscout instance and is not recommended.
  * `SECURE_HSTS_HEADER` (`true`) - Add HTTP Strict Transport Security (HSTS) header. Possible values `false`, or `true`.
  * `SECURE_HSTS_HEADER_INCLUDESUBDOMAINS` (`false`) - includeSubdomains options for HSTS. Possible values `false`, or `true`.
  * `SECURE_HSTS_HEADER_PRELOAD` (`false`) - ask for preload in browsers for HSTS. Possible values `false`, or `true`.
  * `SECURE_CSP` (`false`) - Add Content Security Policy headers. Possible values `false`, or `true`.
  * `SECURE_CSP_REPORT_ONLY` (`false`) - If set to `true` allows to experiment with policies by monitoring (but not enforcing) their effects. Possible values `false`, or `true`.

### Views

  Nightscout allows to create custom, simplified views using a predefined set of elements. This option is available under `[+]` link in the main menu.
  
  List of available items:
  * `SGV` - Sensor Glucose Value
  * `SGV age` - time since the last SGV read
  * `SGV delta` - change of SGV in the last 5 minutes
  * `Trend arrow` - icon of the SG trend
  * `Time` - current time
  * `Line break` - invisible item that will move following items to the next line (by default all are showing on the same level)
  
  All visible items have `Size` property which allows to customize the view even more. Also, all items may appear multiple times on the view.
  
  Apart from adding items, it is possible to customize other aspects of the views, like selecting `Color` or `Black` background. The first one will indicate current BG threshold (green = in range; blue = below range; yellow = above range; red = urgent below/above).
  `Show SGV age` option will make `SGV age` item appear `Always` or only if the predefined threshold is reached: `Only after threshold`. Breaching `SGV age threshold` will also make `Color` background turn grey and strike through `SGV`.
  `Clock view configurator` will generate an URL (available under `Open my clock view!` link) that could be bookmarked.
  
  There are a few default views available from the main menu: 
  * `Clock` - Shows current BG, trend arrow, and time of day. Grey text on a black background.
  * `Color` - Shows current BG and trend arrow. White text on a color background.
  * `Simple` - Shows current BG. Grey text on a black background.

  If you launch one of these views in a fullscreen view in iOS, you can use a left-to-right swipe gesture to exit the view.

### Split View

  Some users will need easy access to multiple Nightscout views at the same time. We have a special view for this case, accessed on /split path on your Nightscout URL. The view supports any number of sites between 1 to 8 way split, where the content for the screen can be loaded from multiple Nightscout instances. Note you still need to host separate instances for each Nightscout being monitored including the one that hosts the split view page - these variables only add the ability to load multiple views into one browser page. To set the URLs from which the content is loaded, set:
  * `FRAME_URL_1` - URL where content is loaded, for the first view (increment the number up to 8 to get more views)
  * `FRAME_NAME_1` - Name for the first split view portion of the screen (increment the number to name more views)

### Plugins

  Plugins are used extend the way information is displayed, how notifications are sent, alarms are triggered, and more.

  The built-in/example plugins that are available by default are listed below.  The plugins may still need to be enabled by adding to the `ENABLE` environment variable.

#### Default Plugins

  These can be disabled by adding them to the `DISABLE` variable, for example `DISABLE="direction upbat"`

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
  Calculates BG using sensor and calibration records from and displays an alternate BG values and noise levels. Defaults that can be adjusted with [extended setting](#extended-settings)
  * `DISPLAY` (`unsmoothed`) - Allows the user to control which algorithm is used to calculate the displayed raw BG values using the most recent calibration record.
    * `unfiltered` - Raw BG is calculated by applying the calibration to the glucose record's unfiltered value.
    * `filtered` - Raw BG is calculated by applying the calibration to the glucose record's filtered value. The glucose record's filtered values are generally produced by the CGM by a running average of the unfiltered values to produce a smoothed value when the sensor noise is high.
    * `unsmoothed` - Raw BG is calculated by first finding the ratio of the calculated filtered value (the same value calculated by the `filtered` setting) to the reported glucose value. The displayed raw BG value is calculated by dividing the calculated unfiltered value (the same value calculated by the `unfiltered` setting) by the ratio.  The effect is to exagerate changes in trend direction so the trend changes are more noticeable to the user. This is the legacy raw BG calculation algorithm.

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

##### `bage` (Battery Age)
  Calculates the number of days and hours since the last `Pump Battery Change` treatment that was recorded.
  * `BAGE_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications to remind you of upcoming pump battery change.
  * `BAGE_DISPLAY` (`days`) - Set to `hours` to display time since last `Pump Battery Change` in hours only.
  * `BAGE_INFO` (`312`) - If time since last `Pump Battery Change` matches `BAGE_INFO` hours, user will be warned of upcoming pump battery change (default of 312 hours is 13 days).
  * `BAGE_WARN` (`336`) - If time since last `Pump Battery Change` matches `BAGE_WARN` hours, user will be alarmed to to change the pump battery (default of 336 hours is 14 days).
  * `BAGE_URGENT` (`360`) - If time since last `Pump Battery Change` matches `BAGE_URGENT` hours, user will be issued a persistent warning of overdue change (default of 360 hours is 15 days).

##### `treatmentnotify` (Treatment Notifications)
  Generates notifications when a treatment has been entered and snoozes alarms minutes after a treatment.
  * `TREATMENTNOTIFY_SNOOZE_MINS` (`10`) - Number of minutes to snooze notifications after a treatment is entered
  * `TREATMENTNOTIFY_INCLUDE_BOLUSES_OVER` (`0`) - U value over which the bolus will trigger a notification and snooze alarms

##### `basal` (Basal Profile)
  Adds the Basal pill visualization to display the basal rate for the current time.  Also enables the `bwp` plugin to calculate correction temp basal suggestions.  Uses the `basal` field from the [treatment profile](#treatment-profile). Also uses the extended setting:
  * `BASAL_RENDER` (`none`) - Possible values are `none`, `default`, or `icicle` (inverted)

##### `bolus` (Bolus Rendering)
  Settings to configure Bolus rendering
  * `BOLUS_RENDER_OVER` (`0`) - U value over which the bolus labels use the format defined in `BOLUS_RENDER_FORMAT`. This value can be an integer or a float, e.g. 0.3, 1.5, 2, etc.
  * `BOLUS_RENDER_FORMAT` (`default`) - Possible values are `hidden`, `default` (with leading zero and U), `concise` (with U, without leading zero), and `minimal` (without leading zero and U).
  * `BOLUS_RENDER_FORMAT_SMALL` (`default`) - Possible values are `hidden`, `default` (with leading zero and U), `concise` (with U, without leading zero), and `minimal` (without leading zero and U).
  
##### `connect` (Nightscout Connect)

Connect common diabetes cloud resources to Nightscout.
Include the keyword `connect` in the `ENABLE` list.
Nightscout connection uses extended settings using the environment variable prefix `CONNECT_`.
  * `CONNECT_SOURCE` - The name for the source of one of the supported inputs.  one of `nightscout`, `dexcomshare`, etc...
###### Nightscout

> Work in progress

To sync from another Nightscout site, include `CONNECT_SOURCE_ENDPOINT` and
`CONNECT_SOURCE_API_SECRET`. 
* `CONNECT_SOURCE=nightscout`
* `CONNECT_SOURCE_ENDPOINT=<URL>`
* `CONNECT_SOURCE_API_SECRET=<OPTIONAL_API_SECRET>`

The `CONNECT_SOURCE_ENDPOINT` must be a fully qualified URL and may contain a
`?token=<subject>` query string to specify an accessToken.
The `CONNECT_SOURCE_API_SECRET`, if provided, will be used to create a token
called `nightscout-connect-reader`.  This information or the token provided in
the query will be used to read information from Nightscout and is optional if
the site is readable by default.

Select this driver by setting `CONNECT_SOURCE` equal to `nightscout`.



###### Dexcom Share
To synchronize from Dexcom Share use the following variables.
* `CONNECT_SOURCE=dexcomshare`
* `CONNECT_SHARE_ACCOUNT_NAME=`
* `CONNECT_SHARE_PASSWORD=`

Optional, `CONNECT_SHARE_REGION` and `CONNECT_SHARE_SERVER` do the same thing, only specify one.
* `CONNECT_SHARE_REGION=`  `ous` or `us`. `us` is the default if nothing is
  provided.  Selecting `us` sets `CONNECT_SHARE_SERVER` to `share2.dexcom.com`.
  Selecting `ous` here sets `CONNECT_SHARE_SERVER` to `shareous1.dexcom.com`.
* `CONNECT_SHARE_SERVER=` set the server domain to use.


###### Glooko

> Note: Experimental.

To synchronize from Glooko use the following variables.
* `CONNECT_SOURCE=glooko`
* `CONNECT_GLOOKO_EMAIL=`
* `CONNECT_GLOOKO_PASSWORD=`

By default, `CONNECT_GLOOKO_SERVER` is set to `api.glooko.com` because the
default value for `CONNECT_GLOOKO_ENV` is `default`.
* `CONNECT_GLOOKO_ENV` is the word `default` by defalt.  Other values are
  `development`, `production`, for `api.glooko.work`, and
  `externalapi.glooko.com`, respectively.
* `CONNECT_GLOOKO_SERVER` the hostname server to use - `api.glooko.com` by `default`.

If both, `CONNECT_GLOOKO_SERVER` and `CONNECT_GLOOKO_ENV` are set, only
`CONNECT_GLOOKO_SERVER` will be used.

###### Libre Link Up
To synchronize from Libre Link Up use the following variables.
* `CONNECT_SOURCE=linkup`
* `CONNECT_LINK_UP_USERNAME=`
* `CONNECT_LINK_UP_PASSWORD=`

By default, `CONNECT_LINK_UP_SERVER` is set to `api-eu.libreview.io` because the
default value for `CONNECT_LINK_UP_REGION` is `EU`.
Other available values for `CONNECT_LINK_UP_REGION`:
  * `US`, `EU`, `DE`, `FR`, `JP`, `AP`, `AU`, `AE`

For folks connected to many patients, you can provide the patient ID by setting
the `CONNECT_LINK_UP_PATIENT_ID` variable.

###### Minimed Carelink

To synchronize from Medtronic Minimed Carelink, set the following
environment variables.
* `CONNECT_SOURCE=minimedcarelink`
* `CONNECT_CARELINK_USERNAME`
* `CONNECT_CARELINK_PASSWORD`
* `CONNECT_CARELINK_REGION` Either `eu` to set `CONNECT_CARELINK_SERVER` to
  `carelink.minimed.eu` or `us` to use `carelink.minimed.com`.

For folks using the new Many to Many feature, please provide the username of the
patient to follow using `CONNECT_CARELINK_PATIENT_USERNAME` variable.


##### `bridge` (Share2Nightscout bridge)

> **Deprecated** Please consider using the `connect` plugin instead.

Fetch glucose reading directly from the Dexcom Share service, uses these extended settings:
  * `BRIDGE_USER_NAME` - Your username for the Share service.
  * `BRIDGE_PASSWORD` - Your password for the Share service.
  * `BRIDGE_INTERVAL` (`150000` *2.5 minutes*) - The time (in milliseconds) to wait between each update.
  * `BRIDGE_MAX_COUNT` (`1`) - The number of records to attempt to fetch per update.
  * `BRIDGE_FIRST_FETCH_COUNT` (`3`) - Changes max count during the very first update only.
  * `BRIDGE_MAX_FAILURES` (`3`) - How many failures before giving up.
  * `BRIDGE_MINUTES` (`1400`) - The time window to search for new data per update (the default value is one day in minutes).
  * `BRIDGE_SERVER` (``) - The default blank value is used to fetch data from Dexcom servers in the US. Set to (`EU`) to fetch from European servers instead.

##### `mmconnect` (MiniMed Connect bridge)

> **Deprecated** Please consider using the `connect` plugin instead.

  Transfer real-time MiniMed Connect data from the Medtronic CareLink server into Nightscout ([read more](https://github.com/mddub/minimed-connect-to-nightscout))
  * `MMCONNECT_USER_NAME` - Your user name for CareLink Connect.
  * `MMCONNECT_PASSWORD` - Your password for CareLink Connect.
  * `MMCONNECT_INTERVAL` (`60000` *1 minute*) - Number of milliseconds to wait between requests to the CareLink server.
  * `MMCONNECT_MAX_RETRY_DURATION` (`32`) - Maximum number of total seconds to spend retrying failed requests before giving up.
  * `MMCONNECT_SGV_LIMIT` (`24`) - Maximum number of recent sensor glucose values to send to Nightscout on each request.
  * `MMCONNECT_VERBOSE` - Set this to "true" to log CareLink request information to the console.
  * `MMCONNECT_STORE_RAW_DATA` - Set this to "true" to store raw data returned from CareLink as `type: "carelink_raw"` database entries (useful for development).
  * `MMCONNECT_SERVER` - Set this to `EU` if you're using the European Medtronic services

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
  * `PUMP_WARN_BATT_QUIET_NIGHT` (`false`) - Do not generate battery alarms at night.

##### `openaps` (OpenAPS)
  Integrated OpenAPS loop monitoring, uses these extended settings:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `OPENAPS_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications when OpenAPS isn't looping.  If OpenAPS is going to offline for a period of time, you can add an `OpenAPS Offline` event for the expected duration from Careportal to avoid getting alerts.
  * `OPENAPS_WARN` (`30`) - The number of minutes since the last loop that needs to be exceed before an alert is triggered
  * `OPENAPS_URGENT` (`60`) - The number of minutes since the last loop that needs to be exceed before an urgent alarm is triggered
  * `OPENAPS_FIELDS` (`status-symbol status-label iob meal-assist rssi`) - The fields to display by default.  Any of the following fields: `status-symbol`, `status-label`, `iob`, `meal-assist`, `freq`, and `rssi`
  * `OPENAPS_RETRO_FIELDS` (`status-symbol status-label iob meal-assist rssi`) - The fields to display in retro mode. Any of the above fields.
  * `OPENAPS_PRED_IOB_COLOR` (`#1e88e5`) - The color to use for IOB prediction lines. Colors can be in `#RRGGBB` format, but [other CSS color units](https://www.w3.org/TR/css-color-3/#colorunits) may be used as well.
  * `OPENAPS_PRED_COB_COLOR` (`#FB8C00`) - The color to use for COB prediction lines. Same format as above.
  * `OPENAPS_PRED_ACOB_COLOR` (`#FB8C00`) - The color to use for ACOB prediction lines. Same format as above.
  * `OPENAPS_PRED_ZT_COLOR` (`#00d2d2`) - The color to use for ZT prediction lines. Same format as above.
  * `OPENAPS_PRED_UAM_COLOR` (`#c9bd60`) - The color to use for UAM prediction lines. Same format as above.
  * `OPENAPS_COLOR_PREDICTION_LINES` (`true`) - Enables / disables the colored lines vs the classic purple color.

 Also see [Pushover](#pushover) and [IFTTT Maker](#ifttt-maker).

##### `loop` (Loop)
  iOS Loop app monitoring, uses these extended settings:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `LOOP_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications when Loop isn't looping.
  * `LOOP_WARN` (`30`) - The number of minutes since the last loop that needs to be exceeded before an alert is triggered
  * `LOOP_URGENT` (`60`) - The number of minutes since the last loop that needs to be exceeded before an urgent alarm is triggered
  * Add `loop` to `SHOW_FORECAST` to show forecasted BG.

For remote overrides, the following extended settings must be configured:
  * `LOOP_APNS_KEY` - Apple Push Notifications service (APNs) Key, created in the Apple Developer website.
  * `LOOP_APNS_KEY_ID` - The Key ID for the above key.
  * `LOOP_DEVELOPER_TEAM_ID` - Your Apple developer team ID.
  * `LOOP_PUSH_SERVER_ENVIRONMENT` - (optional) Set this to `production` if you are using a provisioning profile that specifies production aps-environment, such as when distributing builds via TestFlight.

##### `override` (Override Mode)
  Additional monitoring for DIY automated insulin delivery systems to display real-time overrides such as Eating Soon or Exercise Mode:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set

##### `xdripjs` (xDrip-js)
  Integrated xDrip-js monitoring, uses these extended settings:
  * Requires `DEVICESTATUS_ADVANCED="true"` to be set
  * `XDRIPJS_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications when CGM state is not OK or battery voltages fall below threshold.
  * `XDRIPJS_STATE_NOTIFY_INTRVL` (`0.5`) - Set to number of hours between CGM state notifications
  * `XDRIPJS_WARN_BAT_V` (`300`) - The voltage of either transmitter battery, a warning will be triggered when dropping below this threshold.

##### `alexa` (Amazon Alexa)
  Integration with Amazon Alexa, [detailed setup instructions](docs/plugins/alexa-plugin.md)

##### `googlehome` (Google Home/DialogFLow)
  Integration with Google Home (via DialogFlow), [detailed setup instructions](docs/plugins/googlehome-plugin.md)

##### `speech` (Speech)
  Speech synthesis plugin. When enabled, speaks out the blood glucose values, IOB and alarms. Note you have to set the LANGUAGE setting on the server to get all translated alarms.

##### `cors` (CORS)
  Enabled [CORS](https://en.wikipedia.org/wiki/Cross-origin_resource_sharing) so other websites can make request to your Nightscout site, uses these extended settings:
  * `CORS_ALLOW_ORIGIN` (`*`) - The list of sites that are allow to make requests

##### `dbsize` (Database Size)
  Show size of Nightscout Database, as a percentage of declared available space or in MiB.

  Many deployments of Nightscout use free tier of MongoDB Atlas on Heroku, which is limited in size. After some time, as volume of stored data grows, it may happen that this limit is reached and system is unable to store new data. This plugin provides pill that indicates size of Database and shows (when configured) alarms regarding reaching space limit.

  **IMPORTANT:** This plugin can only check how much space database already takes, _but cannot infer_ max size available on server for it. To have correct alarms and realistic percentage, `DBSIZE_MAX` need to be properly set - according to your mongoDB hosting configuration.

  **NOTE:** This plugin rely on db.stats() for reporting _logical_ size of database, which may be different than _physical_ size of database on server. It may work for free tier of MongoDB on Atlas, since it calculate quota according to logical size too, but may fail for other hostings or self-hosted database with quota based on physical size. 
  
  **NOTE:** MongoDB Atlas quota is for **all** databases in cluster, while each instance will get only size of **its own database only**. It is ok when you only have **one** database in cluster (most common scenario) but will not work for multiple parallel databases. In such case, spliting known quota equally beetween databases and setting `DBSIZE_MAX` to that fraction may help, but wont be precise.

  All sizes are expressed as integers, in _Mebibytes_ `1 MiB == 1024 KiB == 1024*1024 B`

  * `DBSIZE_MAX` (`496`) - Maximal allowed size of database on your mongoDB server, in MiB. You need to adjust that value to match your database hosting limits - default value is for standard Heroku mongoDB free tier.
  * `DBSIZE_WARN_PERCENTAGE` (`60`) - Threshold to show first warning about database size. When database reach this percentage of `DBSIZE_MAX` size - pill will show size in yellow. 
  * `DBSIZE_URGENT_PERCENTAGE` (`75`) - Threshold to show urgent warning about database size. When database reach this percentage of `DBSIZE_MAX` size, it is urgent to do backup and clean up old data. At this percentage info pill turns red.
  * `DBSIZE_ENABLE_ALERTS` (`false`) - Set to `true` to enable notifications about database size.
  * `DBSIZE_IN_MIB` (`false`) - Set to `true` to display size of database in MiB-s instead of default percentage.
  
  This plugin should be enabled by default, if needed can be diasabled by adding `dbsize` to the list of disabled plugins, for example: `DISABLE="dbsize"`.

#### Extended Settings
  Some plugins support additional configuration using extra environment variables.  These are prefixed with the name of the plugin and a `_`.  For example setting `MYPLUGIN_EXAMPLE_VALUE=1234` would make `extendedSettings.exampleValue` available to the `MYPLUGIN` plugin.

  Plugins only have access to their own extended settings, all the extended settings of client plugins will be sent to the browser.

  * `DEVICESTATUS_ADVANCED` (`true`) - Defaults to true. Users who only have a single device uploading data to Nightscout can set this to false to reduce the data use of the site.
  * `DEVICESTATUS_DAYS` (`1`) - Defaults to 1, can optionally be set to 2. Users can use this to show 48 hours of device status data for in retro mode, rather than the default 24 hours. Setting this value to 2 will roughly double the bandwidth usage of nightscout, so users with a data cap may not want to update this setting.

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
 In addition to the normal web based alarms, and pushover, there is also integration for [IFTTT Webhooks](https://ifttt.com/maker_webhooks).

 With Maker you are able to integrate with all the other [IFTTT Services](https://ifttt.com/services).  For example you can send a tweet when there is an alarm, change the color of hue light, send an email, send and sms, and so much more.

 1. Setup IFTTT account: [login](https://ifttt.com/login) or [create an account](https://ifttt.com/join)
 2. Follow the  [Detailed IFTTT setup Instructions](docs/plugins/maker-setup.md)
 3. Configure Nightscout by setting these webpage environment variables:
  * `ENABLE` - `maker` should be added to the list of plugins, for example: `ENABLE="maker"`.
  * `MAKER_KEY` - Set this to your secret key (see  [[Detailed Instructions](docs/plugins/maker-setup.md) ) `MAKER_KEY="abcMyExampleabc123defjt1DeNSiftttmak-XQb69p"` This also supports a space delimited list of keys.
  * `MAKER_ANNOUNCEMENT_KEY` - An optional Maker key, will be used for system wide user generated announcements.  If not defined this will fallback to `MAKER_KEY`.  A possible use for this is sending important messages and alarms to another device that you don't want to send all notification too.  This also support a space delimited list of keys.

 Plugins can create custom events, but all events sent to IFTTT webhooks will be prefixed with `ns-`.  The core events are:
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
  * `units` (Profile Units) - blood glucose units used in the profile, either "mg/dl" or "mmol"
  * `dia` (Insulin duration) - value should be the duration of insulin action to use in calculating how much insulin is left active. Defaults to 3 hours.
  * `carbs_hr` (Carbs per Hour) - The number of carbs that are processed per hour, for more information see [#DIYPS](http://diyps.org/2014/05/29/determining-your-carbohydrate-absorption-rate-diyps-lessons-learned/).
  * `carbratio` (Carb Ratio) - grams per unit of insulin.
  * `sens` (Insulin sensitivity) How much one unit of insulin will normally lower blood glucose.
  * `basal` The basal rate set on the pump.
  * `target_high` - Upper target for correction boluses.
  * `target_low` - Lower target for correction boluses.

  Some example profiles are [here](docs/plugins/example-profiles.md).

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
included `Vagrantfile` and `bin/setup.sh` to install OS and node packages to
a virtual machine.

```bash
host$ vagrant up
host$ vagrant ssh
vm$ ./bin/setup.sh
```

The setup script will install OS packages then run `npm install`.

The Vagrant VM serves to your host machine only on 192.168.33.10, you can access
the web interface on [http://192.168.33.10:1337](http://192.168.33.10:1337)

More questions?
---------------

Feel free to [post an issue][issues], but read the [wiki][wiki] first.

[issues]: https://github.com/nightscout/cgm-remote-monitor/issues
[wiki]: https://github.com/nightscout/cgm-remote-monitor/wiki

### Browser testing suite provided by
[![BrowserStack][browserstack-img]][browserstack-url]

[browserstack-img]: /static/images/browserstack-logo.png
[browserstack-url]: https://www.browserstack.com/

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
