# APIv3: Basics tutorial

Nightscout API v3 is a component of [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor) project. 
It aims to provide lightweight, secured and HTTP REST compliant interface for your T1D treatment data exchange.

There is a list of REST operations that the API v3 offers (inside `/api/v3` relative URL namespace), we will briefly introduce them in this file.

Each NS instance with API v3 contains self-included OpenAPI specification at [/api/v3/swagger-ui-dist/](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/) relative URL.


---
###  VERSION

[VERSION](https://nsapiv3.herokuapp.com/api3-docs/#/other/get_version) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/version` client code (to get actual versions):
```javascript
const axios = require('axios');
axios.get(`https://nsapiv3.herokuapp.com/api/v3/version`)
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "result": {
    "version": "14.2.0",
    "apiVersion": "3.0.4-alpha",
    "srvDate": 1613056980085,
    "storage": {
      "storage": "mongodb",
      "version": "4.4.3"
    }
  }
}
```


---
###  STATUS

[STATUS](https://nsapiv3.herokuapp.com/api3-docs/#/other/get_status) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/status` client code (to get my actual permissions):
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios.get(`https://nsapiv3.herokuapp.com/api/v3/status`,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "result": {
    "version": "14.2.0",
    "apiVersion": "3.0.4-alpha",
    "srvDate": 1613057148579,
    "storage": {
      "storage": "mongodb",
      "version": "4.4.3"
    },
    "apiPermissions": {
      "devicestatus": "crud",
      "entries": "crud",
      "food": "crud",
      "profile": "crud",
      "settings": "crud",
      "treatments": "crud"
    }
  }
}
```
`"crud"` represents create + read + update + delete permissions for the collection.


---
###  SEARCH

[SEARCH](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/SEARCH) operation filters, sorts, paginates and projects documents from the collection.

Sample GET `/entries` client code (to retrieve last 3 BG values):
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios.get(`https://nsapiv3.herokuapp.com/api/v3/entries?sort$desc=date&limit=3&fields=dateString,sgv,direction`,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "result": [
    {
      "dateString": "2021-02-11T15:25:28.928Z",
      "sgv": 116,
      "direction": "FortyFiveDown"
    },
    {
      "dateString": "2021-02-11T15:20:28.239Z",
      "sgv": 124,
      "direction": "FortyFiveDown"
    },
    {
      "dateString": "2021-02-11T15:15:28.225Z",
      "sgv": 130,
      "direction": "Flat"
    }
  ]
}
```


---
###  CREATE

[CREATE](https://nsapiv3.herokuapp.com/api3-docs/#/generic/post__collection_) operation inserts a new document into the collection.

Sample POST `/treatments` client code:
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
const doc = {
  date: 1613057404186, // (new Date()).getTime(),
  app: 'AndroidAPS',
  device: 'Samsung XCover 4-861536030196001',
  eventType: 'Correction Bolus',
  insulin: 0.3
};
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios(`https://nsapiv3.herokuapp.com/api/v3/treatments`,
      {
        method: 'post',
        data: doc,
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 201,
  "identifier": "5b0f7124-475f-5db0-824c-a73c5eea0975",
  "lastModified": 1613057523148
}
```


---
###  READ

[READ](https://nsapiv3.herokuapp.com/api3-docs/#/generic/get__collection___identifier_) operation retrieves you a single document from the collection by its identifier.

Sample GET `/treatments/{identifier}` client code:
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
const identifier = '5b0f7124-475f-5db0-824c-a73c5eea0975';
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios.get(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}`,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "result": {
    "date": 1613057404186,
    "app": "AndroidAPS",
    "device": "Samsung XCover 4-861536030196001",
    "eventType": "Correction Bolus",
    "insulin": 0.3,
    "utcOffset": 0,
    "created_at": "2021-02-11T15:30:04.186Z",
    "identifier": "5b0f7124-475f-5db0-824c-a73c5eea0975",
    "srvModified": 1613057523148,
    "srvCreated": 1613057523148,
    "subject": "test-admin"
  }
}
```


---
###  LAST MODIFIED

[LAST MODIFIED](https://nsapiv3insecure.herokuapp.com/api3-docs/#/other/LAST-MODIFIED) operation finds the date of last modification for each collection.

Sample GET `/lastModified` client code (to get latest modification dates):
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios.get(`https://nsapiv3.herokuapp.com/api/v3/lastModified`,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "result": {
    "srvDate": 1613057924021,
    "collections": {
      "devicestatus": 1613057731281,
      "entries": 1613057728148,
      "profile": 1580337948416,
      "treatments": 1613057523148
    }
  }
}
```


---
###  UPDATE

[UPDATE](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/put__collection___identifier_) operation updates existing document in the collection.

Sample PUT `/treatments/{identifier}` client code (to update `insulin` from 0.3 to 0.4):
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
const identifier = '5b0f7124-475f-5db0-824c-a73c5eea0975';
const doc = {
  date: 1613057404186,
  app: 'AndroidAPS',
  device: 'Samsung XCover 4-861536030196001',
  eventType: 'Correction Bolus',
  insulin: 0.4
};
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}`,
      {
        method: 'put',
        data: doc,
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "lastModified": 1613058295307
}
```


---
###  PATCH

[PATCH](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/patch__collection___identifier_) operation partially updates existing document in the collection.

Sample PATCH `/treatments/{identifier}` client code (to update `insulin` from 0.4 to 0.5):
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
const identifier = '5b0f7124-475f-5db0-824c-a73c5eea0975';
const doc = {
  insulin: 0.5
};
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}`,
      {
        method: 'patch',
        data: doc,
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200
}
```


---
###  DELETE

[DELETE](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/delete__collection___identifier_) operation deletes existing document from the collection.

Sample DELETE `/treatments/{identifier}` client code:
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
const identifier = '5b0f7124-475f-5db0-824c-a73c5eea0975';
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}`,
      {
        method: 'delete',
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200
}
```


---
###  HISTORY

[HISTORY](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/HISTORY2) operation queries all changes since the timestamp.

Sample HISTORY `/treatments/history/{lastModified}` client code:
```javascript
const axios = require('axios');
const accessToken = 'token=testadmin-ad3b1f9d7b3f59d5';
const lastModified = 1613057520148;
axios.get(`https://nsapiv3.herokuapp.com/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios(`https://nsapiv3.herokuapp.com/api/v3/treatments/history/${lastModified}`,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });
```
Sample result:
```json
{
  "status": 200,
  "result": [
    {
      "date": 1613057404186,
      "app": "AndroidAPS",
      "device": "Samsung XCover 4-861536030196001",
      "eventType": "Correction Bolus",
      "insulin": 0.5,
      "utcOffset": 0,
      "created_at": "2021-02-11T15:30:04.186Z",
      "identifier": "5b0f7124-475f-5db0-824c-a73c5eea0975",
      "srvModified": 1613058548149,
      "srvCreated": 1613057523148,
      "subject": "test-admin",
      "modifiedBy": "test-admin",
      "isValid": false
    }
  ]
}
```
Notice the `"isValid":false` field marking the deletion of the document.
