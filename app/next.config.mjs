import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app imports ABIs from ../shared/abi, outside this package, so the repo root is the tracing/turbopack root.
  outputFileTracingRoot: path.join(here, ".."),
  turbopack: { root: path.join(here, "..") },
};

export default nextConfig;
