<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Contributing to cgm-remote-monitor](#contributing-to-cgm-remote-monitor)
  - [Design & new features](#design--new-features)
  - [Develop on `dev`](#develop-on-dev)
  - [Style Guide](#style-guide)
  - [Create a prototype](#create-a-prototype)
  - [Submit a pull request](#submit-a-pull-request)
  - [Bug fixing](#bug-fixing)
  - [Comments and issues](#comments-and-issues)
  - [Co-ordination](#co-ordination)
  - [Other Dev Tips](#other-dev-tips)
  - [List of Contributors](#list-of-contributors)
    - [Core developers, contributing developers, coordinators and documentation writers](#core-developers-contributing-developers-coordinators-and-documentation-writers)
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

## Installation for development

Nightscout is a Node.js application. The basic installation of the software for local purposes is:

1. Clone the software to your local machine using git
2. Install Node from https://nodejs.org/en/download/
2. Use `npm` to install Nightscout dependencies by invoking `npm install` in the project directory. Note the
   dependency installation has to be done using a non-root user - _do not use root_ for development and hosting
   the software!
3. Get a Mongo database by either installing Mongo locally, or get a free cloud account from mLab or MongoDB Atlas.
4. Configure Nightscout by copying `my.env.template` to `my.env` and run it - see the next chapter in the instructions

## Develop on `dev`

We develop on the `dev` branch. All new pull requests should be targeted to `dev`. The `master` branch is only used for distributing the latest version of the tested sources.

You can get the `dev` branch checked out using `git checkout dev`.

Once checked out, install the dependencies using `npm install`, then copy the included `my.env.template`file to `my.env` and edit the file to include your settings (like the Mongo URL). Leave the `NODE_ENV=development` line intact. Once set, run the site using `npm run dev`. This will start Nightscout in the development mode, with different code packaging rules and automatic restarting of the server using nodemon, when you save changed files on disk. The client also hot-reloads new code in, but it's recommended to reload the website after changes due to the way the plugin sandbox works.

Note the template sets `INSECURE_USE_HTTP` to `true` to enable the site to work over HTTP in local development.

If you want to additionaly test the site in production mode, create a file called `my.prod.env` that's a copy of the dev file but with `NODE_ENV=production` and start the site using `npm run prod`.

## REST API

Nightscout implements a REST API for data syncronization. The API is documented using Swagger. To access the documentation
for the API, run Nightscout locally and load the documentation from /api-docs (or read the associated swagger.json and swagger.yaml
files locally).

Note all dates used to access the API and dates stored in the objects are expected to comply with the ISO-8601 format and
be deserializable by the Javascript Date class. Of note here is the dates can contain a plus sign which has a special meaning in URL encoding, so when issuing requests that place dates to the URL, take special care to ensure the data is properly URL
encoded.

## Design & new features

If you intend to add a new feature, please allow the community to participate in the design process by creating an issue to discuss your design. For new features, the issue should describe what use cases the new feature intends to solve, or which existing use cases are being improved.

Note Nightscout has a plugin architecture for adding new features. We expect most code for new features live inside a Plugin, so the code retains a clear separation of concerns. If the Plugin API doesn't implement all features you need to implement your feature, please discuss with us on adding those features to the API. Note new features should under almost no circumstances require changes to the existing plugins.

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

If in doubt, format your code with `js-beautify --indent-size 2 --comma-first  --keep-array-indentation`

## Create a prototype

Fork cgm-remote-monitor and create a branch. You can create a branch using `git checkout -b wip/add-my-widget`. This creates a new branch called `wip/add-my-widget`.  The `wip` stands for work in progress and is a common prefix so that when know what to expect when reviewing many branches.

## Submit a pull request

When you are done working with your prototype, it can be tempting to post on popular channels such as Facebook.  We encourage contributors to submit their code for review, debate, and release before announcing features on social media.

This can be done by checking your code `git commit -avm 'my improvements are here'`, the branch you created back to your own fork. This will probably look something like `git push -u origin wip/add-my-widget`.

Now that the commits are available on github, you can click on the compare buttons on your fork to create a pull request.  Make sure to select [Nightscout's `dev` branch](https://github.com/nightscout/cgm-remote-monitor/tree/dev).

We assume all new Pull Requests are at least smoke tested by the author and all code in the PR actually works.
Please include a description of what the features do and rationalize why the changes are needed.

If you add any new NPM module dependencies, you have to rationalize why they are needed - we prefer pull requests that reduce dependencies, not add them.
Before releasing a a new version, we check with `npm audit` if our dependencies don't have known security issues. 

When adding new features that add configuration options, please ensure the `README` document is amended with information on the new configuration.

## Bug fixing

If you've fixed a bug, please consider adding a unit test to the `/tests` folder that reproduces the original bug without the change.

Try to identify the root cause of the issue and fix the issue. Pull requests that simply add null checks to hide issues are unlikely to be accepted.

This can be done by committing your code `git commit -avm 'my
improvements are here'`, and pushing it to the branch you created on your own
fork. This will probably look something like
`git push -u origin wip/add-my-widget`.

Please include instructions how to test the changes.

## Comments and issues

We encourage liberal use of the comments, including images where appropriate.

## Co-ordination

Most cgm-remote-monitor hackers use github's ticketing system, along with Facebook cgm-in-the-cloud, and gitter.

We use git-flow, with `master` as our production, stable branch, and `dev` is used to queue up for upcoming releases.  Everything else is done on branches, hopefully with names that indicate what to expect.

Once `dev` has been reviewed and people feel it's time to release, we follow the git-flow release process, which creates a new tag and bumps the version correctly.  See sem-ver for versioning strategy.

Every commit is tested by travis.  We encourage adding tests to validate your design.  We encourage discussing your use cases to help everyone get a better understanding of your design.

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

### Core developers, contributing developers, coordinators and documentation writers

[@andrew-warrington]: https://github.com/andrew-warrington
[@apanasef]: https://github.com/apanasef
[@bewest]: https://github.com/bewest
[@danamlewis]: https://github.com/danamlewis
[@diabetlum]: https://github.com/diabetlum
[@herzogmedia]: https://github.com/herzogmedia
[@jamieowendexcom ]: https://github.com/jamieowendexcom 
[@janrpn]: https://github.com/janrpn
[@jasoncalabrese]: https://github.com/jasoncalabrese 
[@jizhongwen]: https://github.com/jizhongwen
[@jpcunningh]: https://github.com/jpcunningh
[@jweismann]: https://github.com/jweismann
[@komarserjio]: https://github.com/komarserjio
[@LuminaryXion]: https://github.com/LuminaryXion
[@mcdafydd]: https://github.com/mcdafydd
[@mdomox]: https://github.com/mdomox
[@MilosKozak]: https://github.com/MilosKozak
[@oteroos]: https://github.com/oteroos
[@PieterGit]: https://github.com/PieterGit
[@rarneson]: https://github.com/rarneson
[@rickfriele]: https://github.com/rickfriele
[@scottleibrand]: https://github.com/scottleibrand
[@sulkaharo]: https://github.com/sulkaharo
[@tynbendad]: https://github.com/tynbendad
[@unsoluble]: https://github.com/unsoluble
[@viderehh]: https://github.com/viderehh
[@OpossumGit]: https://github.com/OpossumGit

| Contribution area                     | List of contributors |
| ------------------------------------- | ---------------------------------- |
| Core developers:                      | [@jasoncalabrese] [@MilosKozak] [@PieterGit] [@sulkaharo] | 
| Former Core developers: (not active): | [@bewest] |
| Contributing developers:              | [@jpcunningh] [@scottleibrand] [@komarserjio] [@jweismann] |
| Release coordination 0.10.x:          | [@PieterGit] [@sulkaharo] |
| Release coordination 0.11.x:          | [@PieterGit] |
| Issue/Pull request coordination:      | Please volunteer |
| Cleaning up git fork spam:            | Please volunteer |
| Documentation writers:                | [@andrew-warrington][@unsoluble] [@tynbendad] [@danamlewis] [@rarneson] |

### Plugin contributors

| Contribution area                     | List of developers   | List of testers
| ------------------------------------- | -------------------- | -------------------- |
| [`alexa` (Amazon Alexa)](README.md#alexa-amazon-alexa)| Please volunteer | Please volunteer |
| [`ar2` (AR2 Forecasting)](README.md#ar2-ar2-forecasting)| Please volunteer | Please volunteer |
| [`basal` (Basal Profile)](README.md#basal-basal-profile)| Please volunteer | Please volunteer |
| [`boluscalc` (Bolus Wizard)](README.md#boluscalc-bolus-wizard)| Please volunteer | Please volunteer |
| [`bridge` (Share2Nightscout bridge)](README.md#bridge-share2nightscout-bridge)| Please volunteer | Please volunteer |
| [`bwp` (Bolus Wizard Preview)](README.md#bwp-bolus-wizard-preview)| Please volunteer | Please volunteer |
| [`cage` (Cannula Age)](README.md#cage-cannula-age)| [@jpcunningh] | Please volunteer |
| [`careportal` (Careportal)](README.md#careportal-careportal)| Please volunteer | Please volunteer |
| [`cob` (Carbs-on-Board)](README.md#cob-carbs-on-board)| Please volunteer | Please volunteer |
| [`cors` (CORS)](README.md#cors-cors)| Please volunteer | Please volunteer |
| [`delta` (BG Delta)](README.md#delta-bg-delta)| Please volunteer | Please volunteer |
| [`devicestatus` (Device Status)](README.md#devicestatus-device-status)| Please volunteer | Please volunteer |
| [`direction` (BG Direction)](README.md#direction-bg-direction)| Please volunteer | Please volunteer |
| [`errorcodes` (CGM Error Codes)](README.md#errorcodes-cgm-error-codes)| Please volunteer | Please volunteer |
| [`food` (Custom Foods)](README.md#food-custom-foods)| Please volunteer | Please volunteer |
| [`googlehome` (Google Home)](README.md#google-home) |[@mdomox] [@rickfriele] | [@mcdafydd] [@oteroos] [@jamieowendexcom] | 
| [`iage` (Insulin Age)](README.md#iage-insulin-age)| Please volunteer | Please volunteer |
| [`iob` (Insulin-on-Board)](README.md#iob-insulin-on-board)| Please volunteer | Please volunteer |
| [`loop` (Loop)](README.md#loop-loop)| Please volunteer | Please volunteer |
| [`mmconnect` (MiniMed Connect bridge)](README.md#mmconnect-minimed-connect-bridge)| Please volunteer | Please volunteer |
| [`openaps` (OpenAPS)](README.md#openaps-openaps)| Please volunteer | Please volunteer |
| [`profile` (Treatment Profile)](README.md#profile-treatment-profile)| Please volunteer | Please volunteer |
| [`pump` (Pump Monitoring)](README.md#pump-pump-monitoring)| Please volunteer | Please volunteer |
| [`rawbg` (Raw BG)](README.md#rawbg-raw-bg)| [@jpcunningh] | Please volunteer |
| [`sage` (Sensor Age)](README.md#sage-sensor-age)| @jpcunningh | Please volunteer |
| [`simplealarms` (Simple BG Alarms)](README.md#simplealarms-simple-bg-alarms)| Please volunteer | Please volunteer |
| [`speech` (Speech)](README.md#speech-speech) | [@sulkaharo] | Please volunteer |
| [`timeago` (Time Ago)](README.md#timeago-time-ago)| Please volunteer | Please volunteer |
| [`treatmentnotify` (Treatment Notifications)](README.md#treatmentnotify-treatment-notifications)| Please volunteer | Please volunteer |
| [`upbat` (Uploader Battery)](README.md#upbat-uploader-battery)| [@jpcunningh] | Please volunteer |
| [`xdrip-js` (xDrip-js)](README.md#xdrip-js-xdrip-js)| [@jpcunningh] | Please volunteer |

### Translators

See `/translations` of your Nightscout, to view the current translation coverage and the missing items.
Languages with less than 90% coverage will be removed in a future Nightscout versions.

| Language      | List of translators | Status
| ------------- | -------------------- |-------------------- |
| Български (`bg`) |Please volunteer| OK |
| Čeština (`cs`) |Please volunteer|OK |
| Deutsch (`de`) |[@viderehh] [@herzogmedia] |OK |
| Dansk (`dk`)  | [@janrpn] |OK |
| Ελληνικά `(el`)|Please volunteer|Needs attention: 68.5%|
| English (`en`)|Please volunteer|OK|
| Español (`es`) |Please volunteer|OK|
| Suomi (`fi`)|[@sulkaharo] |OK|
| Français (`fr`)|Please volunteer|OK|
| עברית (`he`)|Please volunteer|OK|
| Hrvatski (`hr`)|[@OpossumGit]|Needs attention: 47.8% - committed 100% to dev|
| Italiano (`it`)|Please volunteer|OK|
| 日本語 (`ja`)|[@LuminaryXion]|Working on this|
| 한국어 (`ko`)|Please volunteer|Needs attention: 80.6%|
| Norsk (Bokmål) (`nb`)|Please volunteer|OK|
| Nederlands (`nl`)|[@PieterGit]|OK|
| Polski (`pl`)|Please volunteer|OK|
| Português (Brasil) (`pt`)|Please volunteer|OK|
| Română (`ro`)|Please volunteer|OK|
| Русский (`ru`)|[@apanasef]|OK|
| Slovenčina (`sk`)|Please volunteer|OK|
| Svenska (`sv`)|Please volunteer|OK|
| Türkçe (`tr`)|[@diabetlum]|OK|
| 中文（简体） (`zh_cn`) | [@jizhongwen]|OK|
| 中文（繁體） (`zh_tw`) | [@jizhongwen]|Needs attention: 25.0%
| 日本語 (`ja_jp`) | [@LuminaryXion]|


### List of all contributors
| Contribution area                     | List of contributors |
| ------------------------------------- | -------------------- |
| All active developers: | [@jasoncalabrese] [@jpcunningh] [@jweismann] [@komarserjio] [@mdomox] [@MilosKozak] [@PieterGit] [@rickfriele] [@sulkaharo]
| All active testers/documentors: | [@danamlewis] [@jamieowendexcom] [@mcdafydd] [@oteroos] [@rarneson] [@tynbendad] [@unsoluble]
| All active translators: | [@apanasef] [@jizhongwen] [@viderehh] [@herzogmedia] [@LuminaryXion] [@OpossumGit]

