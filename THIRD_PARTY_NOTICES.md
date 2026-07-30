# Third-party notices

ONEComputer includes the following third-party software. This inventory records
the direct packages added for the structured Chat surface; transitive package
licenses remain available in their installed package metadata and distribution
files.

## Vercel AI SDK

- `ai` 7.0.37
- `@ai-sdk/react` 4.0.40
- Copyright Vercel, Inc. and contributors
- License: Apache License 2.0
- Source: <https://github.com/vercel/ai>
- License text: <https://github.com/vercel/ai/blob/main/LICENSE>

These packages run locally in the ONEComputer web and Control applications.
Their inclusion does not require Vercel hosting, AI Gateway, or another
Vercel-hosted runtime service.

## Moby seccomp profile

- `packages/kasm-adapter/src/cowork-seccomp-profile.json` is derived from
  `moby/profiles` tag `seccomp/v0.2.1`.
- Base profile SHA-256:
  `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`.
- Semantic modification: allow only `socket(AF_VSOCK)` in addition to the
  upstream default allowlist.
- Copyright Moby project authors and contributors
- License: Apache License 2.0
- Source: <https://github.com/moby/profiles/blob/seccomp/v0.2.1/seccomp/default.json>
- License text: <https://github.com/moby/profiles/blob/main/LICENSE>
