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

## Design & new features

If you intend to add a new feature, please allow the community to participate in the design process by creating an issue to discuss your design. For new features, the issue should describe what use cases the new feature intends to solve, or which existing use cases are being improved.

Note Nighscout has a plugin architecture for adding new features. We expect most code for new features live inside a Plugin, so the code retains a clear separation of concerns. If the Plugin API doesn't implement all features you need to implement your feature, please discuss with us on adding those features to the API. Note new features should under almost no circumstances require changes to the existing plugins.

## Develop on `dev`

We develop on the `dev` branch. All new pull requests should be targeted to `dev`. The `master` branch is only used for distributing the latest version of the tested sources.

You can get the dev branch checked out using `git checkout dev`.

## Style Guide

Some simple rules, that will make it easier to maintain our codebase:

* All indenting should use 2 space where possible (js, css, html, etc)
* A space before function parameters, such as: `function boom (name, callback) { }`, this makes searching for calls easier
* Name your callback functions, such as `boom('the name', function afterBoom ( result ) { }`
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

If you add any new NPM module dependencies, you have to rationalize why there are needed - we prefer pull requests that reduce dependencies, not add them.

When adding new features that add confugration options, please ensure the `README` document is amended with information on the new configuration.

## Bug fixing

If you've fixed a bug, please consider adding a unit test to the `/tests` folder that reproduces the original bug without the change.

Try to identify the root cause of the issue and fix the issue. Pull requests that simply add null checks to hide issues are unlikely to be accepted.

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
* Get a local dev environment setup if you haven't already
* Try breaking up big features/improvements into small parts.  It's much easier to accept small PR's
* Create tests for your new code, and for the old code too.  We are aiming for a full test coverage.
* If your going to be working in old code that needs lots of reformatting consider doing the clean as a separate PR.
* If you can find others to help test your PR is will help get them merged in sooner.
 
