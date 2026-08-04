---
name: make-a-site
description: Build and publish a simple owner-only static Vite site into LemmaComputer Sites. Use when an employee asks to make, vibe-code, publish, deploy, update, or republish a small website or web app from a disposable LemmaComputer workspace.
---

# Make a Site

Create and publish the smallest useful static site. This MVP accepts exactly one built file: `dist/index.html` up to 512 KB.

## Workflow

1. Use the employee's existing project when one is named. Otherwise copy the bundled `assets/vite-static` template into a new workspace folder.
2. Keep all HTML and CSS in `index.html`. Do not add remote scripts, APIs, secrets, databases, background work, or extra build assets.
3. Run `npm install`, then `npm run build` from the project folder.
4. Verify `dist/index.html` exists and is the only regular file under `dist`.
5. Publish only after the build succeeds:

```bash
lemmacomputer-sites publish --name "Site name" --slug "site-name" --dist "/absolute/project/dist"
```

Use a lowercase hyphenated slug. Publishing the same slug creates a new immutable revision of the employee's existing site.

Report success only when `lemmacomputer-sites` returns JSON with `published:true`. Tell the employee the site is available under LemmaComputer → Sites. If the command fails, report the error plainly and do not claim the site is live.
