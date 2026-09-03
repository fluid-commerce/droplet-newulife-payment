import path from "node:path";
import type { NextConfig } from "next";

/**
 * Next configuration.
 *
 * ## Why this file is inside `src/` rather than at the repo root
 *
 * Next resolves its app directory with `findDir(root, "app")`, which prefers
 * `<root>/app` over `<root>/src/app` and offers no way to override it. This
 * repo still contains the Rails app at `app/`, so building from the repo root
 * makes Next scan Rails' directory, find no routes, and emit an empty app.
 *
 * So Next is pointed at `src` as its project directory (`next build src` — see
 * the scripts in package.json), which makes `src/app` the app router and puts
 * this config, `tsconfig.json` and `next-env.d.ts` beside it.
 *
 * When the Rails app is removed in the follow-up PR, these three files move up
 * one level and the commands lose their `src` argument. Nothing else changes —
 * no source file moves, no import path changes.
 */
const nextConfig: NextConfig = {
  // The SDK ships TypeScript source (its exports map points at src/), and it is
  // linked from ../vendor rather than installed, so Next has to compile it.
  transpilePackages: ["@fluid-app/droplet-sdk"],

  // Dependencies live in the repo root's node_modules, one level above the
  // project directory, so tracing has to start there or the standalone bundle
  // ships without them.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),

  // Standalone output keeps the Docker image small — see Dockerfile.next.
  output: "standalone",

  // This app is embedded in Fluid via an iframe, and the Rails app it replaces
  // cleared X-Frame-Options for exactly that reason
  // (config/initializers/security_headers.rb). Next sets no X-Frame-Options of
  // its own, so framing is controlled with CSP frame-ancestors instead, which
  // is the header modern browsers actually honour for this.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://*.fluid.app",
          },
        ],
      },
    ];
  },

  // Linting runs as its own CI step; keeping it out of `next build` means a
  // lint failure cannot masquerade as a broken Docker build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
