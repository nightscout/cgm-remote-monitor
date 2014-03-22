cgm-remote-monitor (a.k.a. NightScout)
======================================

This acts as a web-based CGM (Continuous Glucose Montinor) to allow multiple caregivers to remotely view a patients glucose data in realtime.  The server reads a MongoDB which is intended to be data from a physical CGM, where it sends new SGV (sensor glucose values) as the data becomes available.  The data is then displayed graphically and blood glucose values are predicted 0.5 hours ahead using a autoregressive second order model.  Alarms are generated for high and low values, which can be cleared by any watcher of the data.

Install
---------------

Requirements:

- [Node.js](http://nodejs.org/)

Clone this repo then install dependencies into the root of the project:

```bash
$ npm install
$ bower install
```

Usage
---------------

The data being uploaded from the server to the client is from a MongoDB server such as [mongolab][mongodb].  In order to access the database, the appropriate credentials need to be filled into the [JSON][json] file in the root directory.  SGV data from the database is assumed to have the following fields: date, sgv.  Once all that is ready, just host your web app on your service of choice.

[mongodb]: https://mongolab.com
[json]: https://github.com/rnpenguin/cgm-remote-monitor/blob/master/database_configuration.json

More questions?
---------------

Feel free to [post an issue][issues].

[issues]: https://github.com/rnpenguin/cgm-remote-monitor/issues

License
---------------

This is experimental software and NOT intended for treatment of any kind. It is provided under the [MIT license][mit], so you can do with it whatever you wish except hold me responsible if it does something you don't like.

[mit]: http://www.opensource.org/licenses/mit-license.php
