# Publishing contract

`dist/` is packaged as a deterministic ZIP and validated again by Control. It must contain root `index.html`, at most 500 regular files, at most 50 MB extracted, at most 10 MB per file, and at most 20 MB compressed.

Allowed extensions are HTML, CSS, JavaScript modules, JSON, CSV, common web images, and local web fonts. Hidden paths, source maps, `node_modules`, symbolic links, credentials, connection strings, remote URLs, outbound browser calls, and `<base>` are rejected. All navigation and asset paths must remain relative to the bundle.

The published viewer runs the site in a script-enabled sandbox without same-origin privileges. Load bundled JSON or CSV with ordinary relative calls such as `fetch("./data/snapshot.json")`. Lemma authorizes the bundle-resource URLs; generated code must not read login cookies, implement authentication, or copy those temporary URLs into source. Share only the stable site URL.

The successful first publish writes `<project>/.lemmacomputer/site.json`. This non-secret binding records schema version, site ID, slug, stable URL, and current version. Future publishes from that project use the site ID and must match the original workspace/project binding. The binding is written only after Control confirms that the ArtifactStore copy is durable and live.

Published versions are immutable. `restore` changes the live version pointer; it does not rewrite artifacts or workspace source.

Sites have no runtime database. Use versioned JSON/CSV snapshots for dashboard data. A direct MySQL/PostgreSQL connection, arbitrary API, or server-side workload is outside this Sites product.
