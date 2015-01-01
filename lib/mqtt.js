'use strict';

var es = require('event-stream');
var Long = require('long');
var decoders = require('sgvdata/lib/protobuf');
var direction = require('sgvdata/lib/utils').direction;
var mqtt = require('mqtt');
var moment = require('moment');

function process(client) {
    var stream = es.through(
        function _write(data) {
            this.push(data);
        }
    );
    return stream;
}

function every(storage) {
    function iter(item, next) {
        storage.create(item, next);
    }

    return es.map(iter);
}

function downloader() {
    var opts = {
        model: decoders.models.G4Download
        , json: function (o) {
            return o;
        }
        , payload: function (o) {
            return o;
        }
    };
    return decoders(opts);
}

function toSGV(proto, receiver_time, download_time) {
    console.log("Receiver time: ", receiver_time);
    console.log("Record time: ", proto.sys_timestamp_sec);
    console.log("Download time: ", download_time.unix());
    var record_offset = receiver_time - proto.sys_timestamp_sec;
    var record_time = download_time.subtract(record_offset, 'second');

    console.log("errr", " Offset: ", record_offset, " Record time: ", record_time.format());

    var obj = {
        device: 'dexcom'
        , date: record_time.unix() * 1000
        , dateString: record_time.format()
        , sgv: proto.sgv_mgdl
        , direction: direction(proto.trend)
        , noise: proto.noise
        , type: 'sgv'
    };
    return obj;
}

function createProtoStream(packet, download_time) {
    var stream = es.readArray(packet.sgv);
    var receiver_time = packet.receiver_system_time_sec;

    function map(item, next) {
        var r = toSGV(item, receiver_time, download_time);
        console.log("ITEM", item, "TO SGV", r);
        next(null, r);
    }

    return stream.pipe(es.map(map));
}

function toCal(proto, receiver_time, download_time) {
    console.log("Receiver time: ", receiver_time);
    console.log("Record time: ", proto.sys_timestamp_sec);
    console.log("Download time: ", download_time.unix());
    var record_offset = receiver_time - proto.sys_timestamp_sec;
    var record_time = download_time.subtract(record_offset, 'second');

    console.log("errr", " Offset: ", record_offset, " Record time: ", record_time.format());

    var obj = {
        device: 'dexcom'
        , date: record_time.unix() * 1000
        , dateString: record_time.format()
        , slope: proto.slope
        , intercept: proto.intercept
        , scale: proto.scale
        , type: 'cal'
    };
    return obj;
}

function createCalProtoStream(packet, download_time) {
    var stream = es.readArray(packet.cal);
    var receiver_time = packet.receiver_system_time_sec;

    function map(item, next) {
        var r = toCal(item, receiver_time, download_time);
        console.log("ITEM", item, "TO CAL", r);
        next(null, r);
    }

    return stream.pipe(es.map(map));
}

function toSensor(proto, receiver_time, download_time) {
    console.log("Receiver time: ", receiver_time);
    console.log("Record time: ", proto.sys_timestamp_sec);
    console.log("Download time: ", download_time.unix());
    var record_offset = receiver_time - proto.sys_timestamp_sec;
    var record_time = download_time.subtract(record_offset, 'second');

    console.log("errr", " Offset: ", record_offset, " Record time: ", record_time.format());

    var obj = {
        device: 'dexcom'
        , date: record_time.unix() * 1000
        , dateString: record_time.format()
        , filtered: new Long(proto.filtered).toInt()
        , unfiltered: new Long(proto.unfiltered).toInt()
        , rssi: proto.rssi
        , type: 'sensor'
    };
    return obj;
}

function createSensorProtoStream(packet, download_time) {
    var stream = es.readArray(packet.sensor);
    var receiver_time = packet.receiver_system_time_sec;

    function map(item, next) {
        var r = toSensor(item, receiver_time, download_time);
        console.log("ITEM", item, "TO Sensor", r);
        next(null, r);
    }

    return stream.pipe(es.map(map));
}

function toMeter(proto, receiver_time, download_time) {
    console.log("Receiver time: ", receiver_time);
    console.log("Record time: ", proto.sys_timestamp_sec);
    console.log("Download time: ", download_time.unix());
    var record_offset = receiver_time - proto.sys_timestamp_sec;
    var record_time = download_time.subtract(record_offset, 'second');

    console.log("errr", " Offset: ", record_offset, " Record time: ", record_time.format());

    var obj = {
        device: 'dexcom'
        , date: record_time.unix() * 1000
        , dateString: record_time.format()
        , mbg: proto.mbg
        , type: 'mbg'
    };
    return obj;
}

function createMeterProtoStream(packet, download_time) {
    var stream = es.readArray(packet.meter);
    var receiver_time = packet.receiver_system_time_sec;

    function map(item, next) {
        var r = toMeter(item, receiver_time, download_time);
        console.log("ITEM", item, "TO Meter", r);
        next(null, r);
    }

    return stream.pipe(es.map(map));
}

function configure(env, core, devicestatus) {
    var uri = env['MQTT_MONITOR'];
    var opts = {
        encoding: 'binary',
        clean: false,
        clientId: 'master'
    };
    var client = mqtt.connect(uri, opts);
    var downloads = downloader();
    client.subscribe('sgvs');
    client.subscribe('published');
    client.subscribe('/downloads/protobuf', {qos: 2}, granted);
    client.subscribe('/uploader', granted);
    client.subscribe('/entries/sgv', granted);
    function granted() {
        console.log('granted', arguments);
    }


    client.on('message', function (topic, msg) {
        console.log('topic', topic);
        console.log(topic, 'on message', 'msg', msg.length);
        switch (topic) {
            case '/uploader':
                console.log({type: topic, msg: msg.toString()});
                break;
            case '/downloads/protobuf':
                var b = new Buffer(msg, 'binary');
                console.log("BINARY", b.length, b.toString('hex'));
                try {
                    var packet = downloads.parse(b);
                    if (!packet.type) {
                        packet.type = topic;
                    }
                } catch (e) {
                    console.log("DID NOT PARSE", e);
                    break;
                }
                console.log('DOWNLOAD msg', msg.length, packet);
                console.log('download SGV', packet.sgv[0]);
                console.log('download_timestamp', packet.download_timestamp, Date.parse(packet.download_timestamp));
                console.log("WRITE TO MONGO");
                var download_timestamp = moment(packet.download_timestamp);
                createProtoStream(packet, download_timestamp).pipe(core.persist(function empty(err, result) {
                    console.log("DONE WRITING SGV TO MONGO", result);
                }));
                createCalProtoStream(packet, download_timestamp).pipe(core.persist(function empty(err, result) {
                    console.log("DONE WRITING Cal TO MONGO", result);
                }));
                createMeterProtoStream(packet, download_timestamp).pipe(core.persist(function empty(err, result) {
                    console.log("DONE WRITING Meter TO MONGO", result);
                }));
                createSensorProtoStream(packet, download_timestamp).pipe(core.persist(function empty(err, result) {
                    console.log("DONE WRITING Sensor TO MONGO", err);
                }));
                packet.type = "download";
                devicestatus.create({
                    uploaderBattery: packet.uploader_battery,
                    created_at: download_timestamp.toISOString()
                }, function empty(err, result) {
                    console.log("DONE WRITING TO MONGO devicestatus ", result, err);
                });

                core.create([ packet ], function empty(err, res) {
                    console.log("Download written to mongo: ", packet)
                });


                // core.write(packet);
                break;
            default:
                console.log(topic, 'on message', 'msg', msg);
                // core.write(msg);
                break;
        }
    });
    client.entries = process(client);
    client.every = every;
    return client;
}
module.exports = configure;
