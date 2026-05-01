// Function to check authentication and add API secret to URL
function authenticatedExport(baseUrl, dateField, fromVal, toVal) {
  // Check if client and hashauth are available
  if (typeof Nightscout === 'undefined' || !Nightscout.client || !Nightscout.client.hashauth) {
    alert('Authentication system not initialized. Please refresh the page.');
    return;
  }
  
  var hashauth = Nightscout.client.hashauth;
  
  // Check if user is authenticated
  if (!hashauth.isAuthenticated()) {
    // Prompt user to authenticate
    alert('You must authenticate with your API secret to export data.');
    hashauth.requestAuthentication();
    return;
  }
  
  // Build URL with API secret
  var url = baseUrl;
  var apiSecretHash = hashauth.hash();
  
  // Add secret parameter if available
  if (apiSecretHash) {
    url += '&secret=' + encodeURIComponent(apiSecretHash);
  }
  
  // Add date range filters
  if (fromVal) {
    url += '&find[' + dateField + '][$gte]=' + encodeURIComponent(fromVal);
  }
  if (toVal) {
    url += '&find[' + dateField + '][$lte]=' + encodeURIComponent(toVal);
  }
  
  // Open the export URL
  window.open(url, '_blank');
}

$('#rp_exportEntries').click(function() {
  var from = $('#rp_from').val();
  var to = $('#rp_to').val();
  authenticatedExport('/api/v1/entries.csv?count=100000', 'dateString', from, to);
});

$('#rp_exportTreatments').click(function() {
  var from = $('#rp_from').val();
  var to = $('#rp_to').val();
  authenticatedExport('/api/v1/treatments.csv?count=100000', 'created_at', from, to);
});

$('#rp_exportProfile').click(function() {
  var from = $('#rp_from').val();
  var to = $('#rp_to').val();
  authenticatedExport('/api/v1/profile.csv?count=100000', 'created_at', from, to);
});

$('#rp_exportDeviceStatus').click(function() {
  var from = $('#rp_from').val();
  var to = $('#rp_to').val();
  authenticatedExport('/api/v1/devicestatus.csv?count=100000', 'created_at', from, to);
});

$('#rp_exportFood').click(function() {
  var from = $('#rp_from').val();
  var to = $('#rp_to').val();
  authenticatedExport('/api/v1/food.csv?count=100000', 'created_at', from, to);
});
