Nightscout Web Monitor (a.k.a. cgm-remote-monitor)
==================================================

![nightscout horizontal](https://cloud.githubusercontent.com/assets/751143/8425633/93c94dc0-1ebc-11e5-99e7-71a8f464caac.png)

[![Build Status][build-img]][build-url]
[![Dependency Status][dependency-img]][dependency-url]
[![Coverage Status][coverage-img]][coverage-url]
[![Codacy Badge][codacy-img]][codacy-url]
[![Discord chat][discord-img]][discord-url]

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/nightscoutbarni/cgm-remote-monitor)

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
[heroku-url]: https://heroku.com/deploy?template=https://github.com/nightscoutbarni/cgm-remote-monitor
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
        - [`googlehome` (Google Home/DialogFLow) [broken]`](#googlehome-google-homedialogflow)
        - [`speech` (Speech)](#speech-speech)
        - [`cors` (CORS)`](#cors-cors)
      - [Extended Settings](#extended-settings)
      - [Pushover](#pushover)
      - [IFTTT Maker](#ifttt-maker)
    - [Treatment Profile](#treatment-profile)

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

... (file continues unchanged)