function getCustomJSON(URL, type, callback){
        
         $.getJSON(URL,function(data){
           
           if(type == "profile") {
             currProfile = data[0].defaultProfile;
             //console.log("Type of data: " + typeof (data[0].store[currProfile].basal[1].time));
             //console.log("Length of object: " + Object.keys(basalProfile).length);
             
             // Define current basal 
             var basalProfile = data[0].store[currProfile].basal;  
             if(timeStr > basalProfile[Object.keys(basalProfile).length-1].time){
                 currBasal = parseFloat(basalProfile[Object.keys(basalProfile).length-1].value);
               }
             else{
               for (i = 1; i < Object.keys(basalProfile).length; i++){
                 //console.log("Basal profile time/value "+i+ ": "+basalProfile[i].time+ " / "+basalProfile[i].value);
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
             // Return values
             callback([currProfile,currBasal,currSens,currCarbRatio]);
           }
           if(type == "BG") {
             // Define current BG
             currBG = parseInt(data[0].sgv);
             callback(currBG);
           }
          });
      }
