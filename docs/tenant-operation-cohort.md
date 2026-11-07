# Tenant-local restore operation cohort

The explicit multitenant preview can select `MULTITENANT_OPERATION_CONFIG`
through its private service environment. The configuration names a provisioned
operation-control schema, a database environment reference, and each tenant's
unique positive advisory-lock key. It requires API, evaluator, realtime and
tenant-admin in one process. Single-tenant commands do not select this option.
Boot checks the schema and effective role privileges; it does not migrate,
provision, grant, suspend or reopen tenants.

The first reference requires direct PostgreSQL connections. Each selected lower
connection checks that `pg`'s connection PID equals PostgreSQL's actual backend
PID. Transaction-pooling proxies are refused rather than silently adopted. The
restore census matches backend PID, backend birth and database role across all
selected clinical, authorization, checkpoint, outbox and suppression schemas.
Application names do not establish membership. Current unknown actors refuse
restore. This census is a diagnostic and refusal check on observed sessions; it
is not a database fence against a new authorized client connecting afterward.
Role memberships that could acquire table privileges through `SET ROLE` are
included in the actor census.

An outer operation remains durably unfinished until its callback, HTTP response,
private IPC response or socket acknowledgement completes. Lower SQL transactions
hold the same tenant's shared admission lock. Restore requires the controller's
exclusive claim and a drained complete cooperative cohort. Suspension and unresolved orphan
operations survive process failure; shutdown does not automatically reopen them.
Successful restore invalidates the selected tenant's retained evaluator output,
notification intents, realtime projections and sockets. Other tenants retain
current process state. Fresh clinical acquisition rebuilds the restored tenant's
output; the retained-time evaluator timer does not substitute for acquisition.

The deployment scope decision is pending. The proposed first preview requires
one co-located process with exclusive custody of its DATA/lifetime database
credentials or equivalent authentication identities, private database ingress
limited to that service and a separately trusted maintenance operator, and no
independent workers, jobs or ad-hoc clients sharing DATA authority. Grants and
credential custody must remain stable throughout restore. These prerequisites
are proposed deployment requirements; boot and the session census do not verify
credential distribution or enforce ingress isolation. An independent client
already holding DATA credentials can bypass the cooperative window. Supporting
such clients requires an additional database or authentication fence. No such
fence is established by the current census or advisory lock.

Shutdown quiesces and drains role resources before releasing the cohort registry.
A failed database-pool drain leaves the registry selected and blocks an
unwindowed fallback. This reference assumes trusted service roles and private
transport ownership. It does not provide multi-process cohort coordination.

Source protocol checks are in `tests/operation-cohort.test.js`,
`tests/tenant-operation-window.test.js`, `tests/evaluator-preview-runtime.test.js`
and `tests/realtime-preview.test.js`. Recording SQL and role constructors do not
establish native PostgreSQL readiness or end-to-end restore acceptance; the
coordinator runs those on the coherent joined candidate.
