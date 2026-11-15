/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ["@collab/shared", "@collab/sync"],
};
