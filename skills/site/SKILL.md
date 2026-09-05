---
name: site
description: Create, edit, validate, preview, publish, inspect, or restore a LemmaComputer Site. Use for dashboard and static website lifecycle requests, including changes to an existing site project or publication.
---

# Site

Build and maintain a small static dashboard or website whose source remains in the workspace and whose published output is an immutable artifact bundle.

## Workflow

1. For an edit, inspect the named project and its `.lemmacomputer/site.json` binding. If the source is missing, explain that the published artifact is not editable source and ask whether to recreate it in a new project.
2. For a new site, copy `assets/vite-static` into a dedicated project folder. Keep the project folder after publication.
3. Put display data in bundled JSON or CSV snapshots. Do not add credentials, direct databases, server code, forms, remote resources, external APIs, background jobs, or runtime package-CDN dependencies.
4. Build the project, then run `lemmacomputer-sites validate --dist <project>/dist`.
5. Preview with `lemmacomputer-sites preview --dist <project>/dist`. Stop the preview after checking it.
6. Publish only after validation and preview:

```bash
lemmacomputer-sites publish --name "Site name" --slug "site-name" --dist "/absolute/project/dist"
```

The CLI automatically republishes the bound site when `.lemmacomputer/site.json` exists. Use `lemmacomputer-sites list`, `inspect --site-id ID`, and `restore --site-id ID --version N` for lifecycle work.

Report success only when publication returns `published:true`, the stable URL, and the version. Sharing and viewer access are managed by LemmaComputer, not by code inside the site.

Read [references/publishing-contract.md](references/publishing-contract.md) when validation fails or before changing the build layout.
