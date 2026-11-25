'use strict';

// Private point-in-time observation, never accepted by an application guard.
// Every provider is an existing synchronous cached getter. Missing proof stays
// unknown; clinical expiry never replaces a separate source/runtime fault.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^EVALUATOR_[A-Z0-9_]{1,54}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => integer(value) && value < 8640000000000000;
const bool = value => typeof value === 'boolean' ? value : null;
const number = value => integer(value) ? value : null;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const version = value => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0
  : typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const failure = () => Object.assign(new Error('EVALUATOR_READINESS_SELECTION_REFUSED'), {code:'EVALUATOR_READINESS_SELECTION_REFUSED'});
function dataSnapshot (input) {
  let remaining = 10000;
  function copy (value, depth) {
    if (--remaining < 0 || depth > 8) throw new Error('Cached fact bound');
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string' && value.length <= 256) return value;
    if (!object(value) && !Array.isArray(value)) throw new Error('Cached fact shape');
    if (!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error('Cached fact prototype');
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field,'value'))) throw new Error('Cached fact accessor');
    if (Array.isArray(value)) {
      if (value.length > 128) throw new Error('Cached fact selection bound');
      return Array.from({length:value.length},(_,i)=>copy(fields[i]?.value,depth+1));
    }
    if (Object.keys(fields).length > 64) throw new Error('Cached fact field bound');
    return Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,copy(field.value,depth+1)]));
  }
  return copy(input,0);
}
function cached (fn, ...args) {
  if (typeof fn !== 'function') return null;
  try {
    const value = fn(...args);
    if (value instanceof Promise) { value.catch(() => {}); return null; }
    return object(value) ? dataSnapshot(value) : null;
  } catch { return null; }
}
function create ({runtimeId, hasTenant, runtimeFacts, workerFacts, windowFacts, platformFacts, sourceFacts, metadataFacts}) {
  if (typeof runtimeId !== 'string' || !UUID.test(runtimeId) || typeof hasTenant !== 'function') throw new TypeError('Explicit readiness witness scope required');
  const configured = tenant => {
    try { const known=hasTenant(tenant);if(known instanceof Promise)known.catch(()=>{});return known===true; }
    catch { return false; }
  };
  return function inspect (request) {
    if (!object(request) || Object.keys(request).sort().join(',') !== 'runtimeId,tenants' || request.runtimeId !== runtimeId ||
        !Array.isArray(request.tenants) || !request.tenants.length || request.tenants.length > 128 ||
        new Set(request.tenants).size !== request.tenants.length || request.tenants.some(tenant => typeof tenant !== 'string' || !UUID.test(tenant) || !configured(tenant))) throw failure();
    const selected = [...request.tenants];
    const snapshot = cached(runtimeFacts, selected), worker = cached(workerFacts), window = cached(windowFacts),
      platform = cached(platformFacts), source = cached(sourceFacts);
    const at = instant(snapshot?.observedAt) ? snapshot.observedAt : null;
    const rows = snapshot?.runtimeId === runtimeId && Array.isArray(snapshot.tenants) &&
      snapshot.tenants.length === selected.length && snapshot.tenants.every((row,i) => row?.tenant === selected[i]) ? snapshot.tenants : null;
    return {kind:'evaluator-readiness-witness',version:1,runtimeId,observedAt:at,tenants:selected.map((tenant,index) => {
      const r = rows?.[index], metadata = cached(metadataFacts,tenant), faults = [];
      let refused = false, unknown = false;
      const group = () => {
        let bad = false, absent = false;
        return { no (code) { bad = true; refused = true; faults.push(code); }, missing (code) { absent = true; unknown = true; faults.push(code); },
          status () { return bad ? 'refused' : absent ? 'unknown' : 'current'; } };
      };
      const runtime = group(), acquisition = group(), trusted = group(), configuration = group(), lifecycle = group(), verification = group(), intake = group();
      const runtimeKeys = ['acquired','inactive','withdrawn','booting','running','metadataPaused','verificationPending'];
      const validRuntime = object(r) && integer(r.generation) && r.generation > 0 && typeof snapshot?.closed === 'boolean' &&
        runtimeKeys.every(key => typeof r[key] === 'boolean') && (r.code === null || typeof r.code === 'string' && CODE.test(r.code));
      const validCode = r?.code === null || typeof r?.code === 'string' && CODE.test(r.code);
      if (!validRuntime) runtime.missing('RUNTIME_UNKNOWN');
      if (snapshot?.closed === true) runtime.no('RUNTIME_CLOSED');
      if (validCode && r.code !== null) runtime.no('RUNTIME_REFUSED');
      if (r?.inactive === true) runtime.no('TENANT_INACTIVE');
      if (r?.withdrawn === true) runtime.no('TENANT_WITHDRAWN');
      if (r?.metadataPaused === true) runtime.no('METADATA_PAUSED');
      if (r?.verificationPending === true) runtime.no('VERIFICATION_PENDING');
      if (r?.booting === true || r?.running === true) runtime.missing('RUNTIME_IN_FLIGHT');
      if (r?.acquired === false) acquisition.missing('ACQUISITION_MISSING');
      const proof = object(r?.proof) ? r.proof : null;
      const proofPresent = proof && integer(proof.generation) && integer(proof.workerGeneration) &&
        hash(proof.identity) && hash(proof.sourceIdentity) && version(proof.settingsVersion) && version(proof.policyGeneration);
      if (!proofPresent) acquisition.missing('ACQUISITION_PROOF_UNKNOWN');
      else if (!integer(r?.generation) || r.generation < 1 || !hash(r.identity) || !hash(r.sourceIdentity) || !version(r.settingsVersion) || !version(r.policyGeneration)) acquisition.missing('ACQUISITION_PROOF_UNKNOWN');
      else if (proof.tenant !== tenant || proof.runtimeId !== runtimeId || proof.generation !== r.generation ||
          proof.identity !== r.identity || proof.sourceIdentity !== r.sourceIdentity || proof.settingsVersion !== r.settingsVersion || proof.policyGeneration !== r.policyGeneration) acquisition.no('ACQUISITION_SCOPE_MISMATCH');
      if (bool(proof?.windowCurrent) === null) acquisition.missing('ACQUISITION_WINDOW_UNKNOWN');
      if (proof?.windowCurrent === false) acquisition.no('ACQUISITION_WINDOW_CHANGED');
      const available = bool(worker?.available), workerGeneration = number(worker?.generation);
      const epochMatches = proofPresent && workerGeneration !== null ? proof.workerGeneration === workerGeneration : null;
      if (available === null || workerGeneration === null) trusted.missing('WORKER_UNKNOWN');
      if (available === false) { trusted.no('WORKER_UNAVAILABLE'); acquisition.no('ACQUISITION_WORKER_UNAVAILABLE'); }
      if (epochMatches === false) { trusted.no('WORKER_EPOCH_MISMATCH'); acquisition.no('ACQUISITION_WORKER_MISMATCH'); }
      if (epochMatches === null) { trusted.missing('WORKER_ACQUISITION_UNKNOWN'); acquisition.missing('ACQUISITION_WORKER_UNKNOWN'); }
      const registryActive = bool(metadata?.registryActive), assigned = bool(metadata?.assigned);
      const paused = bool(metadata?.paused), suspended = bool(metadata?.suspended);
      const metadataPresent = object(metadata) && hash(metadata.sourceIdentity) && version(metadata.settingsVersion) && version(metadata.policyGeneration);
      const identityMatches = proofPresent && metadataPresent ? proof.sourceIdentity === metadata.sourceIdentity && proof.settingsVersion === metadata.settingsVersion && proof.policyGeneration === metadata.policyGeneration : null;
      if (registryActive === null || assigned === null || !metadataPresent) configuration.missing('METADATA_UNKNOWN');
      if (registryActive === false) configuration.no('REGISTRY_INACTIVE');
      if (assigned === false) configuration.no('ASSIGNMENT_REFUSED');
      if (paused === null || suspended === null) { configuration.missing('ACTIVITY_UNKNOWN'); acquisition.missing('ACQUISITION_ACTIVITY_UNKNOWN'); }
      if (paused === true) configuration.no('ACTIVITY_PAUSED');
      if (suspended === true) configuration.no('ACTIVITY_SUSPENDED');
      if (paused === true || suspended === true) acquisition.no('ACQUISITION_ACTIVITY_REFUSED');
      if (identityMatches === false) { configuration.no('METADATA_CHANGED'); acquisition.no('ACQUISITION_METADATA_MISMATCH'); }
      if (identityMatches === null) { configuration.missing('METADATA_ACQUISITION_UNKNOWN'); acquisition.missing('ACQUISITION_METADATA_UNKNOWN'); }
      const windowKeys = ['closed','operational','verifying','verificationFailed','sessionLost','probeFailed'];
      if (!window || !windowKeys.every(key => typeof window[key] === 'boolean')) lifecycle.missing('WINDOW_UNKNOWN');
      for (const [key,code] of [['closed','WINDOW_CLOSED'],['verifying','WINDOW_VERIFYING'],['verificationFailed','WINDOW_VERIFICATION_FAILED'],['sessionLost','WINDOW_SESSION_LOST'],['probeFailed','WINDOW_PROBE_FAILED']]) if (window?.[key] === true) lifecycle.no(code);
      if (window?.operational === false) lifecycle.no('WINDOW_UNAVAILABLE');
      const platformReady = bool(platform?.ready);
      if (platformReady === null || platformReady === true && platform?.code !== null) verification.missing('PLATFORM_UNKNOWN');
      if (platformReady === false) verification.no('PLATFORM_REFUSED');
      const healthy = bool(source?.healthy), schemaBlocked = bool(source?.schemaBlocked), ownerAvailable = bool(source?.ownerAvailable), acceptedCutReady = bool(source?.acceptedCutReady), schemaInFlight = number(source?.schemaInFlight);
      if ([healthy,schemaBlocked,ownerAvailable,acceptedCutReady].includes(null) || schemaInFlight === null) intake.missing('SOURCE_UNKNOWN');
      if (healthy === false) intake.no('SOURCE_UNAVAILABLE');
      if (schemaBlocked === true) intake.no('SCHEMA_BLOCKED');
      if (ownerAvailable === false) intake.no('SOURCE_OWNER_UNAVAILABLE');
      if (acceptedCutReady === false) intake.no('SOURCE_ACCEPTANCE_PENDING');
      if (schemaInFlight !== null && schemaInFlight > 0) intake.no('SCHEMA_VERIFYING');
      let clinicalStatus = 'unknown', pendingSince = null, pendingAgeMs = null, pendingBoundMs = null;
      if (at !== null && object(r) && integer(r.pendingBoundMs) && r.pendingBoundMs > 0 && (r.pendingSince === null || instant(r.pendingSince) && r.pendingSince <= at)) {
        pendingBoundMs = r.pendingBoundMs; pendingSince = r.pendingSince;
        pendingAgeMs = pendingSince === null ? null : at-pendingSince;
        clinicalStatus = pendingSince === null ? 'none' : pendingAgeMs >= pendingBoundMs ? 'expired' : 'within-bound';
      }
      if (clinicalStatus === 'unknown') { unknown = true; faults.push('CLINICAL_UNKNOWN'); }
      const independentStatus = refused ? 'refused' : unknown ? 'unknown' : 'current';
      const classification = independentStatus === 'refused' ? 'source-refused' : independentStatus === 'unknown' ? 'unknown' : clinicalStatus === 'expired' ? 'clinical-expiry-only' : 'ready';
      return {tenant,generation:integer(r?.generation)&&r.generation>0?r.generation:null,
        clinical:{status:clinicalStatus,pendingSince,pendingAgeMs,pendingBoundMs},
        acquisition:{status:acquisition.status(),releasedGeneration:number(proof?.generation),releasedWorkerGeneration:number(proof?.workerGeneration),currentWorkerGeneration:workerGeneration},
        runtime:{status:runtime.status(),closed:bool(snapshot?.closed),inactive:bool(r?.inactive),withdrawn:bool(r?.withdrawn),booting:bool(r?.booting),running:bool(r?.running),metadataPaused:bool(r?.metadataPaused),verificationPending:bool(r?.verificationPending),underlyingCode:validCode?r.code:null},
        worker:{status:trusted.status(),available,generation:workerGeneration,acquisitionEpochMatches:epochMatches},
        metadata:{status:configuration.status(),registryActive,assigned,identityMatches,paused,suspended},
        window:{status:lifecycle.status(),...Object.fromEntries(windowKeys.map(key=>[key,bool(window?.[key])]))},
        platform:{status:verification.status(),ready:platformReady,code:platformReady===false?'PLATFORM_VERIFICATION_REQUIRED':null},
        source:{status:intake.status(),healthy,schemaBlocked,schemaInFlight,acceptedCutReady,ownerAvailable},
        independentStatus,classification,faults:[...new Set(faults)]};
    })};
  };
}
module.exports = {create};
