/**
 * @file Vite configuration for VS Code webview production build
 * @description Builds the React webview application as a single IIFE bundle for VS Code extension.
 *              Uses Rollup's inlineDynamicImports to create a single JS file without ES module imports.
 *              React Compiler (babel-plugin-react-compiler) enabled for automatic memoization.
 *              Process polyfill is now injected via HTML template (see src/webview/components/index.ts).
 *              Outputs to out/webview.js and out/webview.css for VS Code webview consumption.
 */

import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// React Compiler configuration
const ReactCompilerConfig = {
	// Target React 19 (default)
};

export default defineConfig({
	plugins: [
		react({
			babel: {
				plugins: [['babel-plugin-react-compiler', ReactCompilerConfig]],
			},
		}),
		tailwindcss(),
	],
	build: {
		// Output directory for VS Code extension
		outDir: resolve(__dirname, 'out'),
		emptyOutDir: false, // Don't clear out/ as it contains extension.js
		sourcemap: false, // No sourcemaps for production webview
		minify: 'esbuild',

		// Library mode for single file output
		lib: {
			entry: resolve(__dirname, 'src/webview/index.tsx'),
			name: 'PrimeCodeWebview',
			formats: ['iife'], // IIFE format for VS Code webview (no ES modules)
			fileName: () => 'webview.js',
		},

		rollupOptions: {
			output: {
				// Ensure single file output
				inlineDynamicImports: true,
				// CSS output filename
				assetFileNames: (assetInfo) => {
					if (assetInfo.name?.endsWith('.css')) {
						return 'webview.css';
					}
					return 'assets/[name]-[hash][extname]';
				},
				// Extend global scope for IIFE
				extend: true,
			},
		},

		// Target modern browsers (VS Code uses Electron with Chromium)
		target: 'es2020',

		// CSS handling
		cssCodeSplit: false, // Single CSS file
	},

	// Disable module preload for library mode
	optimizeDeps: {
		exclude: ['vscode'],
		esbuildOptions: {
			define: {
				global: 'globalThis',
			},
		},
	},

	// Define for build-time replacement (backup, main polyfill is via banner)
	define: {
		'process.env.NODE_ENV': JSON.stringify('production'),
	},
});
