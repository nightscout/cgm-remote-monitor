
TESTS=tests/*.js
MONGO_CONNECTION?=mongodb://localhost/test_db
CUSTOMCONNSTR_mongo_settings_collection?=test_settings
CUSTOMCONNSTR_mongo_collection?=test_sgvs
MONGO_SETTINGS=MONGO_CONNECTION=${MONGO_CONNECTION} \
	CUSTOMCONNSTR_mongo_collection=${CUSTOMCONNSTR_mongo_collection} \
	CUSTOMCONNSTR_mongo_settings_collection=${CUSTOMCONNSTR_mongo_settings_collection}

all: test

travis-cov:
	NODE_ENV=test \
	${MONGO_SETTINGS} \
	istanbul cover ./node_modules/mocha/bin/_mocha --report lcovonly -- -vvv -R tap ${TESTS} && \
	cat ./coverage/lcov.info | ./node_modules/coveralls/bin/coveralls.js && \
	rm -rf ./coverage

test:
	${MONGO_SETTINGS} \
    mocha --verbose -vvv -R tap ${TESTS}

travis: test travis-cov

.PHONY: test
