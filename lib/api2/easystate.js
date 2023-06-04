'use strict';

function configure (env, ctx) {
  const _ = require('lodash')
    , express = require('express')
    , api = express.Router();

  let cachedResponse;
  let lastResponseTime = 0;
  const cacheTime = 5000;

  api.use(ctx.wares.compression());

  function processSGVs(sgvs) {

    const bgData = [];
    const total = Math.min(48, sgvs.length);

    for (let i = 0; i < total; i++) {
        const bg = sgvs[i];
        bgData.push({
            sgv: bg.mgdl
            , direction: bg.direction
            , mills: bg.mills
            , noise: bg.noise
        });
        }
     return bgData;
    }

  function processTreatments(treatments) {

    const rVal = {
        tempBasals: [],
        treatments: []
    };

    const total = Math.min(120, treatments.length);

    for (let i = 0; i < total; i++) {
        const t = treatments[i];

        if (t.eventType == 'Temp Basal') {
            const _t = {
                duration: t.duration,
                mills: t.mills,
                rate: t.rate
            }
            rVal.tempBasals.push(_t);
            continue;
        }

        if (t.insulin || t.carbs) {
            const _t = {
                mills: t.mills,
                carbs: t.carbs,
                insulin: t.insulin
            }
            rVal.treatments.push(_t);
            continue;
        }
    }

    return rVal;
  }

  function constructState() {

    const p = _.get(ctx, 'sbx.properties');

    const state = {
        iob: _.get(p,'iob.iob'),
        cob: _.get(p,'cob.cob'),
        bwp: _.get(p,'bwp.bolusEstimate'),
        cage: _.get(p,'cage.age'),
        sage: _.get(p,'sage.age'),
        iage: _.get(p,'iage.age'),
        bage: _.get(p,'bage.age'),        
        battery: _.get(p,'upbat.level')
    }
     return state; 
    }

  api.get('/', ctx.authorization.isPermitted('api:*:read'), function (req, res) {

    const now = Date.now();

    let rVal;

    if (lastResponseTime + cacheTime > now) {
        rVal = cachedResponse;
    } else {
        const sgvs = processSGVs(ctx.ddata.sgvs);
        const treatments = processTreatments(ctx.ddata.treatments);
        const profile = ctx.ddata.profiles[0];
        const state = constructState();

        rVal = {
            sgvs,
            treatments,
            profile,
            state
        };

        lastResponseTime = now;
        cachedResponse = rVal;
    }

    res.setHeader('content-type', 'application/json');
    res.write(JSON.stringify(rVal));
    res.end( );
  });

  return api;
}
module.exports = configure;
