import { createHash } from "node:crypto";

export const worktreeResourcePrefix = "lemmacomputer-";
export const legacyWorktreeResourcePrefix = "oc-";

export const worktreeId = ({ root, branch }) => createHash("sha256")
  .update(`${root}\0${branch}`)
  .digest("hex")
  .slice(0, 10);

export const worktreeSlug = (id) => `${worktreeResourcePrefix}${id}`;
export const legacyWorktreeSlug = (id) => `${legacyWorktreeResourcePrefix}${id}`;
export const isWorktreeResourceName = (value) => value?.startsWith(worktreeResourcePrefix) ?? false;

export function applyWorktreeEnvironmentOverrides(contents, overrides, { previousOverrides } = {}) {
  const seen = new Set();
  const lines = contents.trimEnd().split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !overrides.has(match[1])) return line;
    seen.add(match[1]);
    if (previousOverrides && match[2] !== previousOverrides.get(match[1])) return line;
    return `${match[1]}=${overrides.get(match[1])}`;
  });
  const missingOverrides = [...overrides].filter(([key]) => !seen.has(key));
  if (missingOverrides.length) {
    throw new Error(`.env is missing canonical worktree variables: ${missingOverrides.map(([key]) => key).join(", ")}. Run npm run env:update first.`);
  }
  return `${lines.join("\n")}\n`;
}
