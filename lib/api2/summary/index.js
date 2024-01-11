'use strict';

function configure (env, ctx) {
  const _ = require('lodash')
    , basalProcessor = require('./basaldataprocessor')
    , express = require('express')
    , api = express.Router();

  const defaultHours = 6;

  api.use(ctx.wares.compression());

  function removeProps(obj,keys){
    if(Array.isArray(obj)){
      obj.forEach(function(item){
        removeProps(item,keys)
      });
    }
    else if(typeof obj === 'object' && obj != null){
      Object.getOwnPropertyNames(obj).forEach(function(key){
        if(keys.indexOf(key) !== -1)delete obj[key];
        else removeProps(obj[key],keys);
      });
    }
  }

  function processSGVs(sgvs, hours) {

    const bgData = [];
    const dataCap = Date.now() - (hours * 60 * 60 * 1000);

    for (let i = 0; i < sgvs.length; i++) {
        const bg = sgvs[i];
        if (bg.mills >= dataCap) {

          let item = {
            sgv: bg.mgdl
            , mills: bg.mills
          };

          // only push noise data if there is noise
          if (bg.noise != 1) { item.noise = bg.noise; }
          bgData.push(item);

        }
    }
     return bgData;
    }

  // Collect treatments that contain insulin or carbs, temp basals
  function processTreatments(treatments, profile, hours) {

    const rVal = {
        tempBasals: [],
        treatments: [],
        targets: []
    };

    let _temps = [];
    const dataCap = Date.now() - (hours * 60 * 60 * 1000);

    for (let i = 0; i < treatments.length; i++) {
        const t = treatments[i];

        if (t.eventType == 'Temp Basal') {
            _temps.push(t);
            continue;
        }
        if (t.eventType == 'Temporary Target') {
          rVal.targets.push({
            targetTop: Math.round(t.targetTop),
            targetBottom: Math.round(t.targetBottom),
            duration: t.duration*60,
            mills: t.mills
          });
          continue;
      }

        if (t.insulin || t.carbs) {
            if (t.mills >= dataCap) {
              const _t = {
                  mills: t.mills
              };
              if (!isNaN(t.carbs)) _t.carbs = t.carbs;
              if (!isNaN(t.insulin)) _t.insulin = t.insulin;
              rVal.treatments.push(_t);
            }
            continue;
        }
    }

    rVal.tempBasals = basalProcessor.processTempBasals(profile,_temps, dataCap);

    return rVal;
  }

  function constructState() {

    const p = _.get(ctx, 'sbx.properties');

    const state = {
        iob: Math.round(_.get(p,'iob.iob')*100)/100,
        cob: Math.round(_.get(p,'cob.cob')),
        bwp: Math.round(_.get(p,'bwp.bolusEstimate')*100)/100,
        cage: _.get(p,'cage.age'),
        sage: _.get(p,'sage.age'),
        iage: _.get(p,'iage.age'),
        bage: _.get(p,'bage.age'),        
        battery: _.get(p,'upbat.level')
    }
     return state; 
    }

  api.get('/', ctx.authorization.isPermitted('api:*:read'), function (req, res) {

    const hours = req.query.hours || defaultHours;
    const sgvs = processSGVs(ctx.ddata.sgvs, hours);
    const profile = _.clone(ctx.sbx.data.profile.getCurrentProfile());
    removeProps(profile,['timeAsSeconds']);
    const treatments = processTreatments(ctx.ddata.treatments, profile, hours);
    const state = constructState();

    res.setHeader('content-type', 'application/json');
    res.write(JSON.stringify({
      sgvs,
      treatments,
      profile,
      state
  }));
    res.end( );
  });

  return api;
}
module.exports = configure;
