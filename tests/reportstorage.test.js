const should = require('should');
const reportstorage = require('../lib/report/reportstorage');
let storage = require('js-storage').localStorage;
let mockStorage = require('./fixtures/localstorage');
const defaultValues = {
    insulin: true,
    carbs: true,
    basal: true,
    notes: false,
    food: true,
    raw: false,
    iob: false,
    cob: false,
    predicted: false,
    openAps: false,
    insulindistribution: true,
    predictedTruncate: true
};

describe('reportstorage unit tests', () => {

    beforeEach(() => {
        storage._get = storage.get;
        storage._set = storage.set;
        storage.get = mockStorage.get;
        storage.set = mockStorage.set;
    });

    afterEach(() => {
        storage.get = storage._get;
        storage.set = storage._set;
    });

    it('reportstorage definition - returns saveProps and getValue function', () => {
        reportstorage.should.not.be.undefined();
        (reportstorage.getValue instanceof Function).should.be.true();
        (reportstorage.saveProps instanceof Function).should.be.true();
    });

    it('reportstorage.getValue returns default properties', () => {
        let keyCount = 0;
        for (const v in defaultValues) {
            reportstorage.getValue(v).should.equal(defaultValues[v]);
            keyCount++;
        }
        keyCount.should.equal(Object.keys(defaultValues).length);
    });

    it('reportstorage.saveProps sets property in localstorage', () => {
        reportstorage.saveProps({insulin: false});
        should.exist(mockStorage.get('reportProperties'));
        mockStorage.get('reportProperties').insulin.should.be.false();
    });

    it('reportstorage.saveProps ignores property not tracked', () => {
        reportstorage.saveProps({foo: 'bar'});
        should.exist(mockStorage.get('reportProperties'));
        should.not.exist(mockStorage.get('reportProperties').foo);
    });
});
