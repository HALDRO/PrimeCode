/**
 * @file Vite configuration for browser development preview
 * @description Configures Vite dev server for standalone browser preview of the webview.
 *              This allows rapid UI development with HMR without running the VS Code extension.
 *              Uses a separate entry point with mocked VS Code API and theme variables.
 *              Integrates Tailwind CSS v4 via official Vite plugin for proper styling.
 *              React Compiler (babel-plugin-react-compiler) enabled for automatic memoization.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// React Compiler configuration
const ReactCompilerConfig = {
	// Target React 19 (default, can be omitted)
	// target: '19',
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
	root: resolve(__dirname, 'src/webview/dev'),
	publicDir: resolve(__dirname, 'public'),
	server: {
		port: 5173,
		open: true,
		host: true,
	},
	build: {
		outDir: resolve(__dirname, 'dev-dist'),
		emptyOutDir: true,
	},
});
