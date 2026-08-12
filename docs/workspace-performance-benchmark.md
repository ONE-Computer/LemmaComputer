# Workspace performance and Office regression evidence

Phase 0.5 keeps one complete Kasm workspace image. Benchmarking must not remove
LibreOffice, Hermes Office runtimes, Claude Cowork, QEMU, OVMF, `virtiofsd`,
fonts, converters, connectors, policy projection, persistence, or isolation.

## Metadata-only baseline

`benchmark:workspace` is deliberately non-destructive. It reads Git and host
metadata, optionally performs `docker image inspect`, and summarizes supplied
JSONL observations. It never pulls an image or creates, starts, stops, restarts,
or removes a container.

```bash
npm run benchmark:workspace -- \
  --benchmark-id local-lan-baseline \
  --route-id local-lan \
  --route-kind local-lan \
  --deployment-profile customer-managed \
  --client-location same-lan \
  --client-browser "Chromium 150" \
  --network-condition unshaped-lan \
  --profile claude-desktop-standard-v1 \
  --agents claude-desktop \
  --applications firefox \
  --cpus 2 \
  --memory-gib 4 \
  --persistent-home warm \
  --image lemmacomputer/workspace:dev \
  --output .artifacts/workspace-benchmarks/local-lan-baseline.json
```

Use `--skip-image-inspect` when Docker is unavailable. The image measurement is
then explicitly `unavailable`; it is never reported as zero. Docker image
inspection records the exact `Size` field and does not label it as registry
transfer size.

## Runtime observation contract

Runtime instrumentation writes one JSON object per line and passes the file with
`--events`. Every observation is bound to a run, metric, expected unit, and
evidence source:

```json
{"schemaVersion":1,"runId":"warm-01","metric":"profile_initialization_ms","unit":"ms","value":1840,"source":"entrypoint-stage"}
```

The accepted sources separate Docker events, entrypoint stages, browser frames,
Docker statistics, browser-process statistics, network counters, image
inspection, filesystem statistics, Kasm API observations, and reviewed manual
observations. Required metrics with no validated observation remain
`unavailable` in the summary.

The primary target route is:

```text
browser -> signed workspace ingress -> workspace-scoped WebSocket
        -> TCP relay -> KasmVNC :6901
```

Record local-host, local-LAN, and hosted-Kasm routes separately. Do not combine
their latency distributions. A baseline should use at least 20 samples for each
agreed matrix cell and distinguish empty, warm, and representative persistent
homes as well as two- and four-CPU allocations.

The local adapter must retain Kasm's `PreferBandwidth` and dynamic quality range
when it supplies `VNCOPTIONS` to disable the redundant browser-authentication
prompt. Docker replaces the image's complete `VNCOPTIONS` value; supplying only
`DisableBasicAuth` silently disables those adaptive streaming defaults.

The workspace health check uses a one-second startup interval and returns to its
five-second steady-state interval after the first success. Keep those settings
distinct: reducing the steady-state interval would add continuous health-probe
load, while omitting the startup interval can leave an already-listening desktop
reported as provisioning until the next five-second check.

## Office regression corpus

The deterministic corpus contains:

- DOCX with a table and embedded image;
- XLSX with a formula, two worksheets, and chart;
- PPTX with a slide layout, embedded image, and speaker notes.

Regenerate it and verify that Git remains unchanged:

```bash
npm run fixtures:office-regression
git diff --exit-code -- tests/fixtures/office-regression
```

Run the real headless LibreOffice qualification inside the built workspace image
or another environment with the same LibreOffice runtime:

```bash
npm run qualify:office-roundtrip -- \
  --corpus tests/fixtures/office-regression \
  --output .artifacts/office-roundtrip
```

For each format the qualifier performs OOXML to OpenDocument to OOXML, then
reopens the result by converting it to PDF. It verifies the checked-in input
checksum before and after and records hashes and output paths. It never modifies
the corpus.

This automated qualification does not replace GUI editing or the required human
fidelity review in Microsoft 365. It also does not yet invoke Hermes to create or
modify the three formats; those remain runtime gates before adopting an image or
startup optimization.
