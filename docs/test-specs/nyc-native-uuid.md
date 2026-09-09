# NYC process metadata without the nested UUID dependency

Update the existing istanbul-lib-processinfo lockfile entry from 3.0.0 to 3.0.1.
The patch replaces its uuid dependency with Node's crypto.randomUUID. No new
root dependency or override is introduced. The lockfile removes that package's
private uuid installation; this is test-tooling cleanup, not a production RAM
saving.

The actual NYC-resolved ProcessInfo/ProcessDB regression passes on Node 22.23.2
and 24.20.0. It creates parent/child process IDs, saves and reloads them, indexes
files and external IDs, performs asynchronous save and rebuilds the process tree
over two independent cycles. ID format, persistence and links remain intact.

The branch includes the completed MiniMed retirement baseline. A clean install
and production build pass. The full local Node 24.20.0/MongoDB 8 run, using NYC
for real backend coverage, passes 1,939 tests with one existing pending case.
The full npm audit reports zero known vulnerabilities on this candidate.
Full current-head hosted CI and exact merge-tree verification remain required
before integration. Test tooling
has no direct browser/UI or production-runtime behavior change.
