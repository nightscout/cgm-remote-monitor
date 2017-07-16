
# Nightscout tests/builds/analysis
TESTS=tests/*.js
MONGO_CONNECTION?=mongodb://localhost/test_db
CUSTOMCONNSTR_mongo_settings_collection?=test_settings
CUSTOMCONNSTR_mongo_collection?=test_sgvs
MONGO_SETTINGS=MONGO_CONNECTION=${MONGO_CONNECTION} \
	CUSTOMCONNSTR_mongo_collection=${CUSTOMCONNSTR_mongo_collection}

# XXX.bewest: Mocha is an odd process, and since things are being
# wrapped and transformed, this odd path needs to be used, not the
# normal wrapper.  When ./node_modules/.bin/mocha is used, no coverage
# information is generated.  This happens because typical shell
# wrapper performs process management that mucks with the test
# coverage reporter's ability to instrument the tests correctly.
# Hard coding it to the local with our pinned version is bigger for
# initial installs, but ensures a consistent environment everywhere.
# On Travis, ./node_modules/.bin and other `nvm` and `npm` bundles are
# inserted into the default `$PATH` enviroinment, making pointing to
# the unwrapped mocha executable necessary.
MOCHA=./node_modules/mocha/bin/_mocha
# Pinned from dependency list.
ISTANBUL=./node_modules/.bin/istanbul
ANALYZED=./coverage/lcov.info
export CODACY_REPO_TOKEN=e29ae5cf671f4f918912d9864316207c

DOCKER_IMAGE=nightscout/cgm-remote-monitor-travis

all: test

coverage:
	NODE_ENV=test ${MONGO_SETTINGS} \
	${ISTANBUL} cover ${MOCHA} -- -R tap ${TESTS}

report:
	test -f ${ANALYZED} && \
	(npm install coveralls && cat ${ANALYZED} | \
	./node_modules/.bin/coveralls) || echo "NO COVERAGE"
	test -f ${ANALYZED} && \
	(npm install codacy-coverage && cat ${ANALYZED} | \
	YOURPACKAGE_COVERAGE=1 ./node_modules/codacy-coverage/bin/codacy-coverage.js) || echo "NO COVERAGE"

test:
	${MONGO_SETTINGS} ${MOCHA} -R tap ${TESTS}

travis:
	NODE_ENV=test ${MONGO_SETTINGS} \
	${ISTANBUL} cover ${MOCHA} --report lcovonly -- -R tap ${TESTS}

docker_release:
	# Get the version from the package.json file
	$(eval DOCKER_TAG=$(shell cat package.json | jq '.version' | tr -d '"'))
	$(eval NODE_VERSION=$(shell cat .nvmrc))
	#
	# Create a Dockerfile that contains the correct NodeJS version
	cat Dockerfile.example | sed -e "s/^FROM node:.*/FROM node:${NODE_VERSION}/" > Dockerfile
	#
	# Rebuild the image. We do this with no-cache so that we have all security upgrades,
	# since that's more important than fewer layers in the Docker image.
	docker build --no-cache=true -t $(DOCKER_IMAGE):$(DOCKER_TAG) .
	# Push an image to Docker Hub with the version from package.json:
	docker push $(DOCKER_IMAGE):$(DOCKER_TAG)
	#
	# Push the master branch to Docker hub as 'latest'
	if [ "$(TRAVIS_BRANCH)" = "master" ]; then \
		docker tag $(DOCKER_IMAGE):$(DOCKER_TAG) $(DOCKER_IMAGE):latest && \
		docker push $(DOCKER_IMAGE):latest; \
	fi
	#
	# Push the dev branch to Docker Hub as 'latest_dev'
	if [ "$(TRAVIS_BRANCH)" = "dev" ]; then \
		docker tag $(DOCKER_IMAGE):$(DOCKER_TAG) $(DOCKER_IMAGE):latest_dev && \
		docker push $(DOCKER_IMAGE):latest_dev; \
	fi
	rm -f Dockerfile

.PHONY: all coverage docker_release report test travis
