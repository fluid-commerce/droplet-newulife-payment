import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      "**/.next/**",
      "node_modules/**",
      "**/next-env.d.ts",
      // The Rails app and its Vite frontend keep their own toolchain
      // (rubocop, tsconfig.vite.json). Not this config's business.
      "app/**",
      "public/**",
      "vendor/**",
      "docs/**",
      "terraform/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "src/test/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
