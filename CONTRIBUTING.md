<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Contributing to cgm-remote-monitor](#contributing-to-cgm-remote-monitor)
  - [Design](#design)
  - [Develop on `dev`](#develop-on-dev)
  - [Style Guide](#style-guide)
  - [Create a prototype](#create-a-prototype)
  - [Submit a pull request](#submit-a-pull-request)
  - [Comments and issues](#comments-and-issues)
  - [Co-ordination](#co-ordination)
  - [Other Dev Tips](#other-dev-tips)
  - [List of Contributors](#list-of-contributors)
    - [Core and regular contributors](#core-and-regular-contributors)
    - [Plugin contributors](#plugin-contributors)
    - [Translators](#translators)
    - [List of all contributors](#list-of-all-contributors)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->


# Contributing to cgm-remote-monitor

[![Build Status][build-img]][build-url]
[![Dependency Status][dependency-img]][dependency-url]
[![Coverage Status][coverage-img]][coverage-url]
[![Gitter chat][gitter-img]][gitter-url]
[![Stories in Ready][ready-img]][waffle]
[![Stories in Progress][progress-img]][waffle]

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

## Design

Participate in the design process by creating an issue to discuss your
design.

## Develop on `dev`

We develop on the `dev` branch.
You can get the dev branch checked out using `git checkout dev`.

## Style Guide

Some simple rules that will make it easier to maintain our codebase:

* All indenting should use 2 space where possible (js, css, html, etc).
* Include a space before function parameters, such as: `function boom (name, callback) { }`, this makes searching for function calls easier.
* Name your callback functions, such as `boom('the name', function afterBoom ( result ) { }`.
* Don't include author names in the header of your files, if you need to give credit to someone else do it in the commit comment.
* Use single quotes.
* Use the comma first style, for example:

  ```javascript
  var data = {
    value: 'the value'
    , detail: 'the details...'
    , time: Date.now()
  };
  ```

## Create a prototype

Fork cgm-remote-monitor and create a branch.
You can create a branch using `git checkout -b wip/add-my-widget`.
This creates a new branch called `wip/add-my-widget`.  The `wip`
stands for work in progress and is a common prefix so that we know
what to expect when reviewing many branches.

## Submit a pull request

When you are done working with your prototype, it can be tempting to
post on popular channels such as Facebook.  We encourage contributors
to submit their code for review, debate, and release before announcing
features on social media.

This can be done by committing your code `git commit -avm 'my
improvements are here'`, and pushing it to the branch you created on your own
fork. This will probably look something like
`git push -u origin wip/add-my-widget`.

Now that the commits are available on github, you can click on the
compare buttons on your fork to create a pull request.  Make sure to
select [Nightscout's `dev` branch](https://github.com/nightscout/cgm-remote-monitor/tree/dev).

## Comments and issues

We encourage liberal use of the comments, including images where
appropriate.

## Co-ordination

Most cgm-remote-monitor hackers use github's ticketing system, along with Facebook cgm-in-the-cloud, and
gitter.

We use [git-flow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow), with `master` as our production, stable branch, and
`dev` is used to queue changes for upcoming releases.  Everything else is
done on branches, hopefully with names that indicate what to expect.

Once `dev` has been reviewed and people feel it's time to release, we
follow the git-flow release process, which creates a new tag and bumps
the version correctly.  See [sem-ver](https://semver.org/) for versioning strategy.

Every commit is tested by Travis CI.  We encourage adding tests to
validate your design.  We encourage discussing your use cases to help
everyone get a better understanding of your design.

## Other Dev Tips

* Join the [Gitter chat][gitter-url]
* Get a local dev environment setup if you haven't already.
* Try breaking up big features/improvements into small parts.  It's much easier to accept small PR's.
* Create tests for your new code as well as the old code.  We are aiming for a full test coverage.
* If you're going to be working in old code that needs lots of reformatting, consider doing it as a separate PR.
* If you can find others to help test your PR, it will help get them merged in sooner.
 
## List of Contributors  

We welcome new contributors. We do not only need core contributors. Regular or one time contributors are welcomed as well.
Also if you can't code, it's possible to contribute by improving the documentation or by translating Nightscout in your own language

### Core and regular contributors

| Contribution area                     | List of contributors |
| ------------------------------------- | ---------------------------------- |
| Core developers: @jasoncalabrese      | @MilosKozak @PieterGit @sulkaharo | 
| Former Core developers: (not active): | @bewest |
| Contributing developers:              | @jpcunningh @scottleibrand @komarserjio @jweismann 
| ------------------------------------- | ---------------------------------- |
| Release coordination 0.10.x:          | @PieterGit @sulkaharo |
| Release coordination 0.11.x:          | @PieterGit |
| Issue/Pull request coordination:      | PLEASE ADD YOUR NAME HERE |
| Cleaning up git fork spam:            | PLEASE ADD YOUR NAME HERE |
| ------------------------------------- | ---------------------------------- |
| Documentation:                        | @unsoluble @tynbendad @danamlewis @rarneson |

### Plugin contributors

| Contribution area                     | List of developers   | List of testers
| ------------------------------------- | -------------------- | -------------------- |
| [`alexa` (Amazon Alexa)](README.md#alexa-amazon-alexa)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`ar2` (AR2 Forecasting)](README.md#ar2-ar2-forecasting)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`basal` (Basal Profile)](README.md#basal-basal-profile)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`boluscalc` (Bolus Wizard)](README.md#boluscalc-bolus-wizard)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`bridge` (Share2Nightscout bridge)](README.md#bridge-share2nightscout-bridge)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`bwp` (Bolus Wizard Preview)](README.md#bwp-bolus-wizard-preview)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`cage` (Cannula Age)](README.md#cage-cannula-age)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`careportal` (Careportal)](README.md#careportal-careportal)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`cob` (Carbs-on-Board)](README.md#cob-carbs-on-board)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`cors` (CORS)](README.md#cors-cors)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`delta` (BG Delta)](README.md#delta-bg-delta)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`devicestatus` (Device Status)](README.md#devicestatus-device-status)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`direction` (BG Direction)](README.md#direction-bg-direction)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`errorcodes` (CGM Error Codes)](README.md#errorcodes-cgm-error-codes)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`food` (Custom Foods)](README.md#food-custom-foods)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`googlehome`] (Google Home)](README.md#google-home) |@mdomox @rickfriele | @mcdafydd @oteroos @jamieowendexcom | 
| [`iage` (Insulin Age)](README.md#iage-insulin-age)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`iob` (Insulin-on-Board)](README.md#iob-insulin-on-board)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`loop` (Loop)](README.md#loop-loop)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`mmconnect` (MiniMed Connect bridge)](README.md#mmconnect-minimed-connect-bridge)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`openaps` (OpenAPS)](README.md#openaps-openaps)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`profile` (Treatment Profile)](README.md#profile-treatment-profile)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`pump` (Pump Monitoring)](README.md#pump-pump-monitoring)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`rawbg` (Raw BG)](README.md#rawbg-raw-bg)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`sage` (Sensor Age)](README.md#sage-sensor-age)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`simplealarms` (Simple BG Alarms)](README.md#simplealarms-simple-bg-alarms)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`speech` (Speech)](README.md#speech-speech) | @sulkaharo | | PLEASE ADD YOUR NAME HERE |
| [`timeago` (Time Ago)](README.md#timeago-time-ago)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`treatmentnotify` (Treatment Notifications)](README.md#treatmentnotify-treatment-notifications)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`upbat` (Uploader Battery)](README.md#upbat-uploader-battery)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |
| [`xdrip-js` (xDrip-js)](README.md#xdrip-js-xdrip-js)| PLEASE ADD YOUR NAME HERE | PLEASE ADD YOUR NAME HERE |

### Translators

| Language      | List of translators |
| ------------- | -------------------- |
| Български (`bg`) |PLEASE ADD YOUR NAME HERE|
| Čeština (`cs`) |PLEASE ADD YOUR NAME HERE|
| Deutsch (`de`) |@viderehh|
| Dansk (`dk`) |PLEASE ADD YOUR NAME HERE|
| Ελληνικά `(el`)|PLEASE ADD YOUR NAME HERE|
| English (`en`)|PLEASE ADD YOUR NAME HERE|
| Español (`es`) |PLEASE ADD YOUR NAME HERE|
| Suomi (`fi`)|@sulkaharo |
| Français (`fr`)|PLEASE ADD YOUR NAME HERE|
| עברית (`he`)|PLEASE ADD YOUR NAME HERE|
| Hrvatski (`hr`)|PLEASE ADD YOUR NAME HERE|
| Italiano (`it`)|PLEASE ADD YOUR NAME HERE|
| 한국어 (`ko`)|PLEASE ADD YOUR NAME HERE|
| Norsk (Bokmål) (`nb`)|PLEASE ADD YOUR NAME HERE|
| Nederlands (`nl`)|@PieterGit|
| Polski (`pl`)|PLEASE ADD YOUR NAME HERE|
| Português (Brasil) (`pt`)|PLEASE ADD YOUR NAME HERE|
| Română (`ro`)|PLEASE ADD YOUR NAME HERE|
| Русский (`ru`)|@apanasef|
| Slovenčina (`sk`)|PLEASE ADD YOUR NAME HERE|
| Svenska (`sv`)|PLEASE ADD YOUR NAME HERE|
| 中文（简体） (`zh_cn`) | @jizhongwen|
| 中文（繁體） (`zh_tw`) | @jizhongwen|


### List of all contributors
| Contribution area                     | List of contributors |
| ------------------------------------- | -------------------- |
| All active developers: | @jasoncalabrese @mdomox @MilosKozak @PieterGit @rickfriele @sulkaharo
| All active testers/documentors: | @mcdafydd @oteroos @jamieowendexcom @tynbendad
| All active translators: | @apanasef @jizhongwen @viderehh

