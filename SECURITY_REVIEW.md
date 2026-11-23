# EXEcify Security Review

**Review date:** 23 November 2026  
**Scope:** Static source-code review of the public backend repository, focused on the Cloudflare Worker, upload/download flow, GitHub Actions workflow and Windows build script.  
**Reviewer:** AI-assisted internal code review  
**Status:** Preliminary — not an independent security audit or certification.

## Executive summary

This review found one high-priority build correctness defect and several security-hardening gaps. The most important architectural risk is that EXEcify executes uploaded project code and dependency installation scripts on a GitHub-hosted Windows runner. The runner is temporary, but that alone is not equivalent to strong per-job isolation.

**Do not upload secrets, credentials, private certificates or highly confidential source code.** This review does not establish that EXEcify or generated executables are safe.

## Findings

### HIGH — Build metadata omits the selected language

**Files:** `cloudflare/src/index.js`, `.github/scripts/build_job.py`  
**Evidence:** The Worker stores `language` in job metadata, but the `/internal/jobs/:id/manifest` response does not include it. The build script reads `manifest["metadata"].get("language", "python")`. As a result, the build script defaults to Python even when another language was selected, including ZIP uploads that should be auto-detected.

**Impact:** Non-Python builds can be routed through the Python build path or fail unexpectedly. This is primarily a correctness defect, but it undermines the reliability of the advertised multi-language service.

**Recommendation:** Include `language: meta.language` in the manifest metadata and add automated tests for every supported language and ZIP auto-detection.

### HIGH — Untrusted build code runs on a general-purpose hosted runner

**Files:** `.github/workflows/build.yml`, `.github/scripts/build_job.py`  
**Evidence:** The workflow downloads user-controlled source and invokes package managers and build tools. The runner has outbound network access. The script reduces the environment passed to child commands, but uploaded build configuration, dependency hooks and compiler/build scripts still execute on the runner.

**Impact:** Malicious project code or dependencies may attempt to access runner resources, communicate over the network, consume resources or interfere with the build process. A temporary hosted runner reduces persistence between jobs, but does not by itself prove isolation between a job and all runner-level resources.

**Recommendation:** Move untrusted builds into a dedicated disposable VM or sandbox with strict per-job identity, filesystem boundaries, resource quotas, network egress controls and no access to repository write credentials or other jobs. Keep the current service clearly labelled as unsuitable for confidential projects until this is implemented and tested.

### MEDIUM — No application-level rate or concurrency limits are visible

**File:** `cloudflare/src/index.js`  
**Evidence:** Job creation verifies a Turnstile token and limits each project to 150 files and 80 MB, but this review did not find per-IP, per-user or global job-creation limits, nor a concurrency queue/cap in the Worker.

**Impact:** Automated users may create many jobs and consume Worker, KV and GitHub Actions capacity. Free-plan quotas may cause service disruption.

**Recommendation:** Add server-side rate limits, maximum active jobs, queue limits and abuse monitoring. Treat CAPTCHA as one layer, not a complete abuse-prevention system.

### MEDIUM — Turnstile verification does not check the expected hostname

**File:** `cloudflare/src/index.js`  
**Evidence:** `verifyCaptcha` checks only the `success` property returned by Siteverify. It does not compare the returned hostname (and, if configured, action) with the expected website values.

**Impact:** The application does not explicitly enforce that the CAPTCHA token was issued for the intended EXEcify site context.

**Recommendation:** Validate the expected hostname and configured action in the Siteverify response, and fail closed if the response is malformed.

### MEDIUM — Internal job state transitions are not tightly constrained

**File:** `cloudflare/src/index.js`  
**Evidence:** Internal `building`, `result`, `complete` and `fail` actions authenticate using the job token, but the code does not consistently enforce an allowed state-transition sequence. For example, result chunks can be written without first checking that the job is in the `building` state.

**Impact:** A party holding a job token may be able to make unexpected state changes or overwrite result chunks during the job lifecycle. The token is high-entropy, but it is also passed to the build runner.

**Recommendation:** Define and enforce a state machine. Accept result uploads only while building, reject duplicate or conflicting chunk writes, and make completion/failure terminal and idempotent.

### MEDIUM — Build job token is present in the runner process while untrusted builds execute

**Files:** `.github/workflows/build.yml`, `.github/scripts/build_job.py`  
**Evidence:** The job token is provided to the Python orchestration script through the workflow environment. Child commands receive a reduced environment that omits `JOB_TOKEN`, which is a useful mitigation. However, build commands execute under the same runner account while the orchestration process is active.

**Impact:** Environment filtering reduces straightforward inheritance, but it is not a security boundary against hostile code running under the same operating-system account. This review did not perform a process-inspection or token-extraction test.

**Recommendation:** Keep credentials out of the same security context as untrusted build code. Prefer a separate service that brokers narrowly scoped, short-lived operations, or a dedicated isolated VM where the build process cannot inspect the orchestration process or its credentials.

### LOW — Worker error responses expose exception messages

**File:** `cloudflare/src/index.js`  
**Evidence:** The outer exception handler returns `e.message` to the caller.

**Impact:** Unexpected internal error details may be exposed to users. No secret disclosure was demonstrated in this review.

**Recommendation:** Return a generic public error and retain only carefully redacted diagnostic details in access-controlled operational monitoring.

### LOW — Build toolchain is not fully pinned

**File:** `.github/workflows/build.yml`  
**Evidence:** GitHub Actions are pinned to commit SHAs, but the Rust installer is downloaded from a moving URL and installs the current stable toolchain. Other system tools are supplied by the moving `windows-latest` image.

**Impact:** Builds may change over time and depend on upstream toolchain availability or integrity.

**Recommendation:** Pin toolchain versions where practical, verify installer checksums/signatures, and document intentional update procedures.

## Positive controls observed

- The workflow declares `permissions: contents: read`.
- Checkout uses a pinned action SHA and `persist-credentials: false`.
- The workflow has a 25-minute timeout; build commands have individual timeouts.
- Upload paths are checked for traversal, duplicate paths are rejected, and upload/file counts and sizes are limited.
- ZIP extraction checks entry count, expanded size, traversal paths and symbolic-link entries.
- Upload and result chunks are encrypted with AES-256-GCM before being written to Workers KV.
- Job tokens are generated using cryptographically secure randomness.
- Child build processes receive a reduced environment rather than the complete orchestration environment.
- Source and result cleanup paths and KV expiry are implemented.
- Raw compiler stdout/stderr are not copied into build error messages.

These controls were identified by source inspection; their effectiveness has not been independently penetration-tested.

## Review limitations

This was a static review of selected source files on the review date. It did **not** include:
- A live penetration test or exploitation attempts.
- A full review of every frontend, legacy backend, dependency or Cloudflare account setting.
- Verification of production secrets, account permissions, KV contents or retention in provider backups.
- End-to-end builds for every supported language.
- Malware analysis of generated executables.
- An independent third-party assessment.

## Recommended remediation order

1. Fix the missing language field in the internal manifest and add regression tests.
2. Strengthen build isolation so untrusted code cannot share a security context with orchestration credentials.
3. Enforce job state transitions and result-chunk immutability.
4. Add rate/concurrency limits and validate Turnstile hostname/action.
5. Reduce public error detail and pin/verify the remaining toolchain inputs.
6. Run automated tests, dependency scanning and an independent penetration test before making stronger security claims.

**Conclusion:** EXEcify has several useful baseline protections, but this review found material gaps. It should be described as an early-stage project with documented safeguards and limitations — not as independently audited, certified or guaranteed safe.
