# Motion MCP first release: the pipeline worked, the deploy fought back

**Date**: 2026-09-27 (Asia/Saigon)
**Severity**: Medium
**Component**: Release, Docker image, GitHub Actions deploy, VPS
**Status**: Resolved (release live); product decisions pending

## What Happened

We shipped the first end-to-end slice. A brief becomes a creative spec (written by host-opus, or by internal Opus through OpenRouter). The spec becomes Motion IR, then goes through the deterministic compiler or Pi workers, then HyperFrames lint/check/QA, then a preview or final render, then FFmpeg, and out comes an MP4. The server exposes 8 MCP tools over Streamable HTTP with bearer auth, and 218 unit tests pass, including real renders. A live internal-opus 15s 1080p final render cost 135 credits, which is $0.1156 COGS. Commits `21de759..a50db7a` are on `digitopvn/motion-mcp` main, and branch protection requires CI `check`.

Production checks on 2026-09-27:
- `https://app.motion.digitop.ai/healthz` returns 200.
- `/mcp` without a bearer returns 401.
- `tools/list` returns 8 tools, and the `motion_inspect` handshake is OK.
- A host-opus create rendered a preview to R2, and a presigned GET returned 206 `video/mp4`.
- The marketing site `https://motion.digitop.ai` returns 200.

## The Brutal Truth

The product code was the easy part. Nearly all the release pain came from infrastructure we had assumed would work. We lost the most time on the SSH key: sshd said the key was accepted, the runner still failed, and the cause turned out to be two quote characters.

## Technical Details / What We Tried

1. **Browser ensure hung in Docker.** `hyperframes browser ensure` stalled with no useful error because `unzip` was missing from the image. Fix: `apt install unzip`.
2. **Chrome cached in the wrong place.** HyperFrames caches Chrome at `~/.cache/hyperframes` and ignores `PUPPETEER_CACHE_DIR`. We had run ensure as root, so the runtime user couldn't find the browser. Fix: run ensure as the `node` user.
3. **Windows-only path test failed on Linux CI.** Fix: split it into platform-specific tests.
4. **Deploy SSH key rejected.** PowerShell 7 passed `-N '""'` to `ssh-keygen` as a literal two-character passphrase (`""`). sshd accepted the public key, but the runner could not sign with the private key. Diagnosis: we turned on sshd `LogLevel VERBOSE` temporarily, and the log showed `Accepted key ... Postponed publickey`. Fix: regenerate the key with `-N ''`.
5. **Private GHCR package.** The VPS now runs `docker login` with the job's `GITHUB_TOKEN` piped over ssh stdin, and logs out after the pull. A second problem: `compose pull --ignore-buildable` skipped the app because the compose file has `build: .`. Fix: use a plain `docker pull`.

## Root Cause Analysis

We never ran the image build or the deploy path cold before release day. Everything in 1 to 5 would have shown up in a single rehearsal on a clean Linux runner and VPS. Item 4 happened because a key was generated from an interactive Windows shell where the quoting doesn't behave like POSIX.

## Lessons Learned

- Build and smoke-test the container as the runtime user before release. Don't trust env vars to control where a tool caches files; check the actual path.
- Generate deploy keys in bash, or pass `-N ''` explicitly. Then check the key before relying on it: `ssh-keygen -y -f key` should print the public key without asking for a passphrase.
- When sshd accepts a key but auth still fails, look at signing on the client side. A temporary VERBOSE log answers it within minutes.
- Treat `--ignore-buildable` as meaning "skip anything with `build:`", including our own app.

## Next Steps (owner: maintainer, before paid launch)

- Decide whether to keep vision "error" findings as non-blocking for final render (currently only deterministic errors block).
- Confirm that `TRIAL_CREDITS` should default to 500.
- Provision the `POLAR_*` tokens and `TYPESAFE_API_KEY` on the VPS. Both are missing, so billing and that integration are not live.
- Custom director mode is reserved. The dashboard, Taste Memory and pgvector search are deferred and need scheduling.
- Check that sshd `LogLevel` has been set back from VERBOSE.

Status: DONE_WITH_CONCERNS
