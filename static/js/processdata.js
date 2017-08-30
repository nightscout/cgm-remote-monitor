// Fetch info from site via API  
    	function getCustomJSON(URL, type, callback){
        	$.ajax({
            		url: URL,
            		method: 'GET',
            		dataType: 'json',
            		success: function(data){
				if(type == "profile") {
					currProfile = data[0].defaultProfile;
					// Define current basal 
					var basalProfile = data[0].store[currProfile].basal;  
					if(timeStr > basalProfile[Object.keys(basalProfile).length-1].time){
						currBasal = parseFloat(basalProfile[Object.keys(basalProfile).length-1].value);
					}
					 else{
						for (i = 1; i < Object.keys(basalProfile).length; i++){
							if (timeStr < basalProfile[i].time) {
								currBasal = parseFloat(basalProfile[i-1].value);
								break; 
							}
						}
					}
					// Define current sensitivity
					var sensProfile = data[0].store[currProfile].sens;  
					if(timeStr > sensProfile[Object.keys(sensProfile).length-1].time){
						currSens = parseFloat(sensProfile[Object.keys(sensProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(sensProfile).length; i++){
							if (timeStr < sensProfile[i].time) {
								currSens = parseFloat(sensProfile[i-1].value);
								break; 
							}
						}
					}
					// Define current carb ratio
					var ratioProfile = data[0].store[currProfile].carbratio;  
					if(timeStr > ratioProfile[Object.keys(ratioProfile).length-1].time){
						currCarbRatio = parseFloat(ratioProfile[Object.keys(ratioProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(ratioProfile).length; i++){
							if (timeStr < ratioProfile[i].time) {
								currCarbRatio = parseFloat(ratioProfile[i-1].value);
								break; 
							}
						}
					}
					// Define current low and high values 
					var lowProfile = data[0].store[currProfile].target_low;
					if(timeStr > lowProfile[Object.keys(lowProfile).length-1].time){
						lowerBGgoal = parseInt(lowProfile[Object.keys(lowProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(lowProfile).length; i++){
							if (timeStr < lowProfile[i].time) {
								lowerBGgoal = parseInt(lowProfile[i-1].value);
								break; 
							}
						}
					}
					var highProfile = data[0].store[currProfile].target_high;
					if(timeStr > highProfile[Object.keys(highProfile).length-1].time){
						upperBGgoal = parseInt(highProfile[Object.keys(highProfile).length-1].value);
					}
					else{
						for (i = 1; i < Object.keys(highProfile).length; i++){
							if (timeStr < highProfile[i].time) {
								upperBGgoal = parseInt(highProfile[i-1].value);
								break; 
							}
						}
					} 
					
					activeInsulinHours = parseFloat(data[0].store[currProfile].dia);
					
					// Return values
					callback(currProfile,currBasal,currSens,currCarbRatio,lowerBGgoal,upperBGgoal,activeInsulinHours);
				}
               			if(type == "BG") {
					 // Define current BG
					 currBG = parseInt(data[0].sgv);
					 delta30mins = parseInt(data[0].sgv)-parseInt(data[5].sgv);
					 delta60mins = parseInt(data[0].sgv)-parseInt(data[11].sgv);
					 BGtrend = data[0].direction;
					 timestamp = data[0].dateString;
					 callback(currBG,delta30mins,delta60mins,BGtrend);
			       }
				if(type == "Treatments") {
					callback(data);
			       }
            		},
            		error: function(data){
            			document.getElementById("errors").innerHTML = "Derp derp derp.";
            		}
            	});    
      } // end getCustomJSON
      // Fetch nutrition info from MyFitnessPal page  
      function getMFPData(callback){
	      $.ajax({
		      url: MFPurl,
		      method: 'GET',
            	      dataType: 'html',
            	      crossOrigin: true,
		      success: function(data){
			      mfpCode = data;
			      callback(mfpCode);
            	      },
            	      error: function(data){
			      document.getElementById("errors").innerHTML += "MyFitnessPal data could not be pulled";
            	      }
         	}); 
      } // end getMFPData
