# APIv3: Socket.IO storage modifications channel

APIv3 has the ability to broadcast events about all created, edited and deleted documents, using Socket.IO library.

This provides a real-time data exchange experience in combination with API REST operations.

### Complete sample client code
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <title>APIv3 Socket.IO sample</title>

    <link rel="icon" href="images/favicon.png" />
  </head>

  <body>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.2.0/socket.io.js"></script>

	<script>
      const socket = io('https://nsapiv3.herokuapp.com/storage');

      socket.on('connect', function () {
        socket.emit('subscribe', { 
          accessToken: 'testadmin-ad3b1f9d7b3f59d5',
          collections: [ 'entries', 'treatments' ]
        }, function (data) {
          if (data.success) {
            console.log('subscribed for collections', data.collections);
          }
          else {
            console.error(data.message);
          }
        });
      });

      socket.on('create', function (data) {
        console.log(`${data.colName}:created document`, data.doc);
      });

      socket.on('update', function (data) {
        console.log(`${data.colName}:updated document`, data.doc);
      });

      socket.on('delete', function (data) {
        console.log(`${data.colName}:deleted document with identifier`, data.identifier);
      });
	</script>
  </body>
</html>
```

**Important notice: Only changes made via APIv3 are being broadcasted. All direct database or APIv1 modifications are not included by this channel.**

### Subscription (authorization)
The client must first subscribe to the channel that is exposed at `storage` namespace, ie the `/storage` subadress of the base Nightscout's web address (without `/api/v3` subaddress).
```javascript
const socket = io('https://nsapiv3.herokuapp.com/storage');
```


Subscription is requested by emitting `subscribe` event to the server, while including document with parameters:
* `accessToken`: required valid accessToken of the security subject, which has been prepared in *Admin Tools* of Nightscout. 
* `collections`: optional array of collections which the client wants to subscribe to, by default all collections are requested)

```javascript
socket.on('connect', function () {
  socket.emit('subscribe', { 
    accessToken: 'testadmin-ad3b1f9d7b3f59d5',
    collections: [ 'entries', 'treatments' ]
  },
```


On the server, the subject is first identified and authenticated (by the accessToken) and then a verification takes place, if the subject has read access to each required collection. 

An exception is the `settings` collection for which `api:settings:admin` permission is required, for all other collections `api:<collection>:read` permission is required.


If the authentication was successful and the client has read access to at least one collection, `success` = `true` is set in the response object and the field `collections` contains an array of collections which were actually subscribed (granted).
In other case `success` = `false` is set in the response object and the field `message` contains an error message.

```javascript
function (data) {
    if (data.success) {
      console.log('subscribed for collections', data.collections);
    }
    else {
      console.error(data.message);
    }
  });
});
```

### Receiving events
After the successful subscription the client can start listening to `create`, `update` and/or `delete` events of the socket.


##### create
`create` event fires each time a new document is inserted into the storage, regardless of whether it was CREATE or UPDATE operation of APIv3 (both of these operations are upserting/deduplicating, so they are "insert capable"). If the document already existed in the storage, the `update` event would be fired instead.

The received object contains:
* `colName` field with the name of the affected collection 
* the inserted document in `doc` field

```javascript
socket.on('create', function (data) {
  console.log(`${data.colName}:created document`, data.doc);
});
```


##### update
`update` event fires each time an existing document is modified in the storage, regardless of whether it was CREATE, UPDATE or PATCH operation of APIv3 (all of these operations are "update capable"). If the document did not yet exist in the storage, the `create` event would be fired instead.

The received object contains:
* `colName` field with the name of the affected collection 
* the new version of the modified document in `doc` field

```javascript
socket.on('update', function (data) {
  console.log(`${data.colName}:updated document`, data.doc);
});
```


##### delete
`delete` event fires each time an existing document is deleted in the storage, regardless of whether it was "soft" (marking as invalid) or permanent deleting.

The received object contains:
* `colName` field with the name of the affected collection 
* the identifier of the deleted document in the `identifier` field

```javascript
socket.on('delete', function (data) {
  console.log(`${data.colName}:deleted document with identifier`, data.identifier);
});
```