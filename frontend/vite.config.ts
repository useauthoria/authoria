import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    allowedHosts: [
      '.ngrok-free.dev',
      '.ngrok.app',
      'localhost',
    ],
    proxy: {
      '/functions': {
        target: 'https://mzfugvrgehzgupuowgme.supabase.co',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path, // Keep /functions prefix
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // Disable sourcemaps in production for smaller bundle
    // Target modern browsers to reduce bundle size
    target: 'es2020',
    // Enable minification
    minify: 'esbuild',
    // Code splitting and chunk optimization
    rollupOptions: {
      output: {
        // Manual chunk splitting for better caching
        manualChunks: {
          // Vendor chunks
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'chart-vendor': ['recharts'],
          'utils-vendor': ['date-fns', 'zod', 'axios'],
        },
        // Optimize chunk file names for caching
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
    // Chunk size warnings threshold (10KB as recommended)
    chunkSizeWarningLimit: 10000,
    // Disable CSS code splitting for better iframe compatibility
    // CSS will be in a single file, making it easier to load in Shopify iframes
    cssCodeSplit: false,
  },
  css: {
    // Ensure CSS is injected properly for iframe contexts
    devSourcemap: false,
  },
  // Optimize dependencies
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom'],
  },
});

