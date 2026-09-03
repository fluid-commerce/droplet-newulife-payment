import { defineConfig } from 'vite'
import RubyPlugin from 'vite-plugin-ruby'
import tailwindcss from '@tailwindcss/vite'
import FullReload from 'vite-plugin-full-reload'

export default defineConfig({
  // The root tsconfig.json now belongs to the Next.js app and sets
  // `jsx: "preserve"`, which esbuild would otherwise inherit here and leave
  // JSX untransformed. The Rails frontend is typechecked by tsconfig.vite.json.
  esbuild: {
    jsx: 'automatic',
  },
  plugins: [
    RubyPlugin(),
    tailwindcss(),
    FullReload(['config/routes.rb', 'app/views/**/*', 'app/frontend/**/*']),
  ]
})
