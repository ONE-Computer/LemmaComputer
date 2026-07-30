import { Template, defaultBuildLogger } from "e2b";

const image = process.env.ONECOMPUTER_WORKSPACE_IMAGE_REF?.trim();
const name = process.env.E2B_TEMPLATE_NAME?.trim() || "onecomputer-workspace";

if (!image || !image.includes("@sha256:")) {
  throw new Error("ONECOMPUTER_WORKSPACE_IMAGE_REF must be a linux/amd64 image pinned by digest");
}
if (!process.env.E2B_API_KEY?.trim()) {
  throw new Error("E2B_API_KEY is required");
}

const template = Template()
  .fromImage(image)
  .setUser("root");

const build = await Template.build(template, name, {
  cpuCount: 4,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
});

process.stdout.write(`${JSON.stringify({
  templateId: build.templateId,
  name,
  image,
})}\n`);
