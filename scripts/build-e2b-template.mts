import { Template, defaultBuildLogger } from "e2b";

const image = process.env.ONECOMPUTER_WORKSPACE_IMAGE_REF?.trim();
const name = process.env.E2B_TEMPLATE_NAME?.trim() || "onecomputer-workspace:dev";
const registryUsername = process.env.E2B_REGISTRY_USERNAME?.trim();
const registryPassword = process.env.E2B_REGISTRY_PASSWORD?.trim();

if (!image || !image.includes("@sha256:")) {
  throw new Error("ONECOMPUTER_WORKSPACE_IMAGE_REF must be a linux/amd64 image pinned by digest");
}
if (!process.env.E2B_API_KEY?.trim()) {
  throw new Error("E2B_API_KEY is required");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
  throw new Error("E2B_TEMPLATE_NAME must include an immutable tag, for example onecomputer-workspace:qualification");
}
if (Boolean(registryUsername) !== Boolean(registryPassword)) {
  throw new Error("E2B_REGISTRY_USERNAME and E2B_REGISTRY_PASSWORD must be provided together");
}

const template = Template()
  .fromImage(image, registryUsername && registryPassword ? {
    username: registryUsername,
    password: registryPassword,
  } : undefined)
  .setUser("root");

const build = await Template.build(template, name, {
  cpuCount: 4,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
});

process.stdout.write(`${JSON.stringify({
  templateId: build.templateId,
  buildId: build.buildId,
  name,
  tags: build.tags,
  image,
})}\n`);
