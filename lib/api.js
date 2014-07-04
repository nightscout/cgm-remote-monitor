module.exports = function () {
    var express = require('express');
    var api = express();

    api.get('/settings', function (req, res) {
        return res.json({
            'units': 'mg/dl',
            'theme': 'battleship'
        });
    });

    return api;
}();
