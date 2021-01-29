const should = require('should');
const reportstorage = require('../lib/report/reportstorage');

describe('reportstorage unit tests', () => {

    it('reportstorage definition - returns saveProps and getValue function', () => {
        reportstorage.should.not.be.undefined();
        (reportstorage.getValue instanceof Function).should.be.true();
        (reportstorage.saveProps instanceof Function).should.be.true();
    });

    it('reportstorage.getValue returns default properties', () => {
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
        let keyCount = 0;
        for (const v in defaultValues) {
            reportstorage.getValue(v).should.equal(defaultValues[v]);
            keyCount++;
        }
        keyCount.should.equal(Object.keys(defaultValues).length);
    });

    it('reportstorage.saveProps sets property in localstorage', () => {
        const storage = require('js-storage').localStorage;
        const mockStorage = require('./fixtures/localstorage');
        storage.get = mockStorage.get;
        storage.set = mockStorage.set;
        reportstorage.saveProps({insulin: false});
        should.exist(mockStorage.get('reportProperties'));
        mockStorage.get('reportProperties').insulin.should.be.false();
    });

    it('reportstorage.saveProps ignores property not tracked', () => {
        const storage = require('js-storage').localStorage;
        const mockStorage = require('./fixtures/localstorage');
        storage.get = mockStorage.get;
        storage.set = mockStorage.set;
        reportstorage.saveProps({foo: 'bar'});
        should.exist(mockStorage.get('reportProperties'));
        should.not.exist(mockStorage.get('reportProperties').foo);
    });
});
