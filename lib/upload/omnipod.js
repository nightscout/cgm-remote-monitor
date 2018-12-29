'use strict';

var fs = require('fs');
var IBFRecordReader = require('ibf-file-reader/dist/IBFRecord/IBFRecordReader');
var LogRecordParser = require('ibf-file-reader/dist/LogRecord/LogRecordParser');
var LogRecord = require('ibf-file-reader/dist/LogRecord/LogRecord');

function init (env, ctx) {
    var omnipoduploader = {};

    omnipoduploader.handleUpload = function handleUpload (req, res) {
        var filepath = 'uploads/' + req.file.filename;
        readFile(filepath, function (fileErr, logRecord) {
            if (fileErr) {
                console.log(fileErr);
            } else {
                let treatment = logRecordToTreatment(logRecord);
                if (treatment) {
                    ctx.treatments.create(treatment, function logCreateError (err) {
                        if (err) {
                            console.log(err);
                        }
                    });
                }
            }
            fs.unlink(filepath, function logUnlinkError (err) {
                if (err) {
                    console.log(err);
                }
            });
        });
        res.status(204).end();
    }

    return omnipoduploader;
}

/* Converts a log record as read from an IBF file into a treatment appropriate for storage. */
function logRecordToTreatment (obj) {
    if (obj.logType == LogRecord.LogRecordType.HISTORY) {
        var treatment = {
            "created_at": obj.timestamp.toISOString(),
            "enteredBy": "ibf-upload"
        };

        switch(obj.historyLogRecordType) {
            case LogRecord.HistoryLogRecordType.CARB:
                treatment["eventType"] = "Carbs";
                treatment["carbs"] = obj.carbs;
                return treatment;
            case LogRecord.HistoryLogRecordType.BOLUS:
                treatment["eventType"] = "Bolus";
                treatment["insulin"] = obj.units;
                return treatment;
        }
    }

    return null;
}

function readFile (file, callback) {
    fs.readFile(file, (err, buffer) => {
        if (err != null) {
            callback(err);
            return;
        }

        let record;
        while (true) {
            [record, buffer] = IBFRecordReader.readIBFRecord(buffer);

            if (record == null || buffer.length == 0) {
                break;
            }
            let [err, parsed] = LogRecordParser.parseLogRecord(record);
            if (err) {
                callback(err);
            } else if (callback) {
                callback(null, parsed);
            }
        }
    });
}

module.exports = init
