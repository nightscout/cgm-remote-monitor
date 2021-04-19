
require('crypto').randomBytes(1024, function(err, buffer) {
    var token = buffer.toString('hex');
    console.log(token);
});
