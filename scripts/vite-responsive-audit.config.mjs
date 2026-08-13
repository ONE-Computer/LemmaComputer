import path from "node:path";
import baseConfig from "../apps/web/vite.config.mjs";

const webRoot = process.cwd();

export default {
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    dedupe: ["react", "react-dom"],
  },
  server: {
    ...baseConfig.server,
    fs: {
      ...(baseConfig.server?.fs ?? {}),
      allow: [
        path.resolve(webRoot, "../.."),
        path.resolve(webRoot, "../../../.."),
      ],
    },
  },
};
