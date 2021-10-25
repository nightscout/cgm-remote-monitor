# APIv3: Security

### Enforcing HTTPS
APIv3 is ment to run only under SSL version of HTTP protocol, which provides:
- **message secrecy** - once the secure channel between client and server is closed the communication cannot be eavesdropped by any third party
- **message consistency** - each request/response is protected against modification by any third party (any forgery would be detected)
- **authenticity of identities** - once the client and server establish the secured channel, it is guaranteed that the identity of the client or server does not change during the whole session

HTTPS (in use with APIv3) does not address the true identity of the client, but ensures the correct identity of the server. Furthermore, HTTPS does not prevent the resending of previously intercepted encrypted messages by an attacker.


---
###  Authentication and authorization
In APIv3, *API_SECRET* can no longer be used for authentication or authorization. Instead, a roles/permissions security model is used, which is managed in the *Admin tools* section of the web application.


The identity of the client is represented by the *subject* to whom the access level is set by assigning security *roles*. One or more *permissions* can be assigned to each role. Permissions are used in an [Apache Shiro-like style](http://shiro.apache.org/permissions.html "Apache Shiro-like style").


For each security *subject*, the system automatically generates an *access token* that is difficult to guess since it is derived from the secret *API_SECRET*. The *access token* must be included in every secured API operation to decode the client's identity and determine its authorization level. In this way, it is then possible to resolve whether the client has the permission required by a particular API operation.


There are two ways to authorize API calls:
- use `token` query parameter to pass the *access token*, eg. `token=testreadab-76eaff2418bfb7e0`
- use so-called [JSON Web Tokens](https://jwt.io "JSON Web Tokens")
  - at first let the `/api/v2/authorization/request` generates you a particular JWT, eg. `GET https://nsapiv3.herokuapp.com/api/v2/authorization/request/testreadab-76eaff2418bfb7e0`
  - then, to each secure API operation attach a JWT token in the HTTP header, eg. `Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3NUb2tlbiI6InRlc3RyZWFkYWItNzZlYWZmMjQxOGJmYjdlMCIsImlhdCI6MTU2NTAzOTczMSwiZXhwIjoxNTY1MDQzMzMxfQ.Y-OFtFJ-gZNJcnZfm9r4S7085Z7YKVPiaQxuMMnraVk` (until the JWT expires)



---
###  Client timestamps
As previously mentioned, a potential attacker cannot decrypt the captured messages, but he can send them back to the client/server at any later time. APIv3 is partially preventing this by the temporal validity of each secured API call.


The client must include his current timestamp to each call so that the server can compare it against its clock. If the timestamp difference is not within the limit, the request is considered invalid. The tolerance limit is set in minutes in the `API3_TIME_SKEW_TOLERANCE` environment variable.

There are two ways to include the client timestamp to the call:
-  use `now` query parameter with UNIX epoch millisecond timestamp, eg. `now=1565041446908`
- add HTTP `Date` header to the request, eg. `Date: Sun, 12 May 2019 07:49:58 GMT`


The client can check each server response in the same way, because each response contains a server timestamp in the HTTP *Date* header as well.


---
APIv3 security is enabled by default, but it can be completely disabled for development and debugging purposes by setting the web environment variable `API3_SECURITY_ENABLE=false`.
This setting is hazardous and it is strongly discouraged to be used for production purposes!
