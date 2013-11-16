cgm
===
This acts as a web CGM (Continuous Glucose Montinor) to allow multiple user's to view a patients glucose data in realtime.
The server reads a local csv file which is intended to be data from a physical CGM, where it reloads the csv file when new data
becomes available.  The data is then displayed graphically and blood glucose values are predicted 4 hours ahead using a autoregressive 
second order model.  Alarms are generated for high and low values, which can be cleared by any watcher of the data.

![Output sample](https://raw.github.com/rnpenguin/cgm/master/images/demo.gif)


License
===
This is experimental software and not intended for treatment of any kind. It is provided under the MIT license, so you can do with it whatever you wish except hold me responsible if it does something you don't like.

MIT license: http://www.opensource.org/licenses/mit-license.php
