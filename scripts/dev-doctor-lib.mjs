import { constants } from "node:fs";
import { access } from "node:fs/promises";

export const litellmMountedFilePaths = Object.freeze([
  "config/litellm/config.yaml",
  "config/litellm/logging.yaml",
  "integrations/litellm/lemmacomputer_policy_callback.py",
]);

const defaultAccessPath = (path) => access(path, constants.R_OK);

export const inspectReadablePaths = async (paths, { accessPath = defaultAccessPath } = {}) => {
  const diagnostics = [];
  for (const path of paths) {
    try {
      await accessPath(path);
    } catch (error) {
      diagnostics.push({
        path,
        reason: error?.code === "ENOENT" ? "missing" : "unreadable",
      });
    }
  }
  return diagnostics;
};
