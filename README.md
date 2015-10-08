cgm-remote-monitor (a.k.a. NightScout)
======================================
 
[![Build Status](https://travis-ci.org/nightscout/cgm-remote-monitor.png)](https://travis-ci.org/nightscout/cgm-remote-monitor)
[![Dependency Status](https://david-dm.org/nightscout/cgm-remote-monitor.png)](https://david-dm.org/nightscout/cgm-remote-monitor)
[![Gitter chat](https://badges.gitter.im/nightscout.png)](https://gitter.im/nightscout/public)

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

This acts as a web-based CGM (Continuous Glucose Montinor) to allow
multiple caregivers to remotely view a patients glucose data in
realtime.  The server reads a MongoDB which is intended to be data
from a physical CGM, where it sends new SGV (sensor glucose values) as
the data becomes available.  The data is then displayed graphically
and blood glucose values are predicted 0.5 hours ahead using a
autoregressive second order model.  Alarms are generated for high and
low values, which can be cleared by any watcher of the data.

Community maintained fork of the
[original cgm-remote-monitor](https://github.com/rnpenguin/cgm-remote-monitor).

Install
---------------

Requirements:

- [Node.js](http://nodejs.org/)

Clone this repo then install dependencies into the root of the project:

```bash
$ npm install
```

### Vagrant install

Optionally, use [Vagrant](https://www.vagrantup.com/) with the
included `Vagrantfile` and `setup.sh` to install OS and node packages to
a virtual machine.

```bash
host$ vagrant up
host$ vagrant ssh
vm$ setup.sh
```

The setup script will install OS packages then run `npm install`.

The Vagrant VM serves to your host machine only on 192.168.33.10, you can access
the web interface on [http://192.168.33.10:1337](http://192.168.33.10:1337)

Usage
---------------

The data being uploaded from the server to the client is from a
MongoDB server such as [mongolab][mongodb].  In order to access the
database, the appropriate credentials need to be filled into the
[JSON][json] file in the root directory.  SGV data from the database
is assumed to have the following fields: date, sgv.  Once all that is
ready, just host your web app on your service of choice.

[mongodb]: https://mongolab.com
[json]: https://github.com/rnpenguin/cgm-remote-monitor/blob/master/database_configuration.json

### Environment
You can use the default null `database_configuration.json`
config if you set the following environment variables instead.
(Hosting providers often make this easy, and this allows you to avoid
editing anything.)

* `CUSTOMCONNSTR_mongo` - the mongo connection string, corresponds to
  `DB.url`.
* `CUSTOMCONNSTR_mongo_collection` - the mongo collection to use,
   corresponds to `DB.collection`.

Easy to emulate on the commandline:

```bash
echo 'CUSTOMCONNSTR_mongo="mongodb://sally:sallypass@mymongohost.com/db"' >> my.env
echo 'CUSTOMCONNSTR_mongo_collection="sallyCGMCollection"' >> my.env
```

From now on you can run using
```bash
$ env $(cat my.env) PORT=1337 node server.js
```

Your hosting provider probably has a way to set these through their
GUI.

More questions?
---------------

Feel free to [post an issue][issues], but read the [wiki][wiki] first.

[issues]: https://github.com/rnpenguin/cgm-remote-monitor/issues
[wiki]: https://github.com/rnpenguin/cgm-remote-monitor/wiki

License
---------------

[agpl-3]: http://www.gnu.org/licenses/agpl-3.0.txt

    cgm-remote-monitor - web app to broadcast cgm readings
    Copyright (C) 2014 Nightscout contributors.  See the COPYRIGHT file
    at the root directory of this distribution and at
    https://github.com/nightscout/cgm-remote-monitor/blob/master/COPYRIGHT

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.


