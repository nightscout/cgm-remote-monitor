# APIv3: Socket.IO alarm channel

### Complete sample client code
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <title>APIv3 Socket.IO sample for alarms</title>

    <link rel="icon" href="images/favicon.png" />
  </head>

  <body>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.2.0/socket.io.js"></script>

	<script>
      const socket = io('https://nsapiv3.herokuapp.com/alarm');

      socket.on('connect', function () {
        socket.emit('subscribe', { 
          accessToken: 'testadmin-ad3b1f9d7b3f59d5'
        }, function (data) {
          if (data.success) {
            console.log('subscribed for alarms', data.message);
          }
          else {
            console.error(data.message);
          }
        });
      });

      socket.on('announcement', function (data) {
        console.log(data);
      });

      socket.on('alarm', function (data) {
        console.log(data);
      });

      socket.on('urgent_alarm', function (data) {
        console.log(data);
      });

      socket.on('clear_alarm', function (data) {
        console.log(data);
      });
	</script>
  </body>
</html>
```

### Subscription (authorization)
The client must first subscribe to the channel that is exposed at `alarm` namespace, ie the `/alarm` subadress of the base Nightscout's web address (without `/api/v3` subaddress).
```javascript
const socket = io('https://nsapiv3.herokuapp.com/alarm');
```


Subscription is requested by emitting `subscribe` event to the server, while including document with parameter:
* `accessToken`: required valid accessToken of the security subject, which has been prepared in *Admin Tools* of Nightscout. 

```javascript
socket.on('connect', function () {
  socket.emit('subscribe', { 
    accessToken: 'testadmin-ad3b1f9d7b3f59d5'
  }, ...
```


On the server, the subject is identified and authenticated (by the accessToken). Ne special rights are required. 

If the authentication was successful `success` = `true` is set in the response object and the field `message` contains a text response.
In other case `success` = `false` is set in the response object and the field `message` contains an error message.

```javascript
function (data) {
    if (data.success) {
      console.log('subscribed for alarms', data.message);
    }
    else {
      console.error(data.message);
    }
  });
});
```

### Acking alarms and announcements
If the client is successfully subscribed it can ack alarms and announcements by emitting `ack` message.

```javascript
  socket.emit('ack', level, group, silenceTimeInMilliseconds); 
```

where `level` and `group` are values from alarm being acked and `silenceTimeInMilliseconds` is duration. During this time alarms of the same type are not emmited.

### Receiving events
After the successful subscription the client can start listening to `announcement`, `alarm` , `urgent_alarm` and/or `clear_alarm` events of the socket.


##### announcement

The received object contains similiar json:

```javascript
      {
        "level":0,
        "title":"Announcement",
        "message":"test",
        "plugin":{"name":"treatmentnotify","label":"Treatment Notifications","pluginType":"notification","enabled":true},
        "group":"Announcement",
        "isAnnouncement":true,
        "key":"9ac46ad9a1dcda79dd87dae418fce0e7955c68da"
      }
```


##### alarm, urgent_alarm

The received object contains similiar json:

```javascript
      {
        "level":1,
        "title":"Warning HIGH",
        "message":"BG Now: 5 -0.2 → mmol\/L\nRaw BG: 4.8 mmol\/L Čistý\nBG 15m: 4.8 mmol\/L\nIOB: -0.02U\nCOB: 0g",
        "eventName":"high",
        "plugin":{"name":"simplealarms","label":"Simple Alarms","pluginType":"notification","enabled":true},
        "pushoverSound":"climb",
        "debug":{"lastSGV":5,"thresholds":{"bgHigh":180,"bgTargetTop":75,"bgTargetBottom":72,"bgLow":70}},
        "group":"default",
        "key":"simplealarms_1"
      }
```


##### clear_alarm

The received object contains similiar json:

```javascript
      {
        "clear":true,
        "title":"All Clear",
        "message":"default - Urgent was ack'd",
        "group":"default"
      }
```