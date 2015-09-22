
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
[coverage-img]: https://img.shields.io/coveralls/nightscout/cgm-remote-monitor/coverage.svg
[coverage-url]: https://coveralls.io/r/nightscout/cgm-remote-monitor?branch=dev
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

## Create a prototype

Fork cgm-remote-monitor and create a branch.
You can create a branch using `git checkout -b wip/add-my-widget`.
This creates a new branch called `wip/add-my-widget`.  The `wip`
stands for work in progress and is a common prefix so that when know
what to expect when reviewing many branches.

## Submit a pull request

When you are done working with your prototype, it can be tempting to
post on popular channels such as Facebook.  We encourage contributors
to submit their code for review, debate, and release before announcing
features on social media.

This can be done by checking your code `git commit -avm 'my
improvements are here'`, the branch you created back to your own
fork. This will probably look something like
`git push -u origin wip/add-my-widget`.

Now that the commits are available on github, you can click on the
compare buttons on your fork to create a pull request.  Make sure to
select [Nightscout's `dev` branch](https://github.com/nightscout/cgm-remote-monitor/tree/dev).

## Comments and issues

We encourage liberal use of the comments, including images where
appropriate.

## Co-ordination

There is a google groups nightscout-core developers list where lots of
people discuss Nightscout.  Most cgm-remote-monitor hackers use
github's ticketing system, along with Facebook cgm-in-the-cloud, and
gitter system.

We use git-flow, with `master` as our production, stable branch, and
`dev` is used to queue up for upcoming releases.  Everything else is
done on branches, hopefully with names that indicate what to expect.

Once `dev` has been reviewed and people feel it's time to release, we
follow the git-flow release process, which creates a new tag and bumps
the version correctly.  See sem-ver for versioning strategy.

Every commit is tested by travis.  We encourage adding tests to
validate your design.  We encourage discussing your use cases to help
everyone get a better understanding of your design.
