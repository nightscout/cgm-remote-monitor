
# Nightscout tests/builds/analysis
TESTS=tests/*.js
MONGO_CONNECTION?=mongodb://localhost/test_db
CUSTOMCONNSTR_mongo_settings_collection?=test_settings
CUSTOMCONNSTR_mongo_collection?=test_sgvs
MONGO_SETTINGS=MONGO_CONNECTION=${MONGO_CONNECTION} \
	CUSTOMCONNSTR_mongo_collection=${CUSTOMCONNSTR_mongo_collection} \
	CUSTOMCONNSTR_mongo_settings_collection=${CUSTOMCONNSTR_mongo_settings_collection}

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

all: test

coverage:
	NODE_ENV=test ${MONGO_SETTINGS} \
	${ISTANBUL} cover ${MOCHA} -- -R tap ${TESTS}

report:
	test -f ${ANALYZED} && \
	(npm install coveralls && cat ${ANALYZED} | \
	./node_modules/.bin/coveralls) || echo "NO COVERAGE"

test:
	${MONGO_SETTINGS} ${MOCHA} -R tap ${TESTS}

travis:
	NODE_ENV=test ${MONGO_SETTINGS} \
	${ISTANBUL} cover ${MOCHA} --report lcovonly -- -R tap ${TESTS}

.PHONY: all coverage report test travis
