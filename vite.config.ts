/**
 * @file Vite configuration for browser development preview
 * @description Configures Vite dev server for standalone browser preview of the webview.
 *              This allows rapid UI development with HMR without running the VS Code extension.
 *              Uses a separate entry point with mocked VS Code API and theme variables.
 *              Integrates Tailwind CSS v4 via official Vite plugin for proper styling.
 *              React Compiler (babel-plugin-react-compiler) enabled for automatic memoization.
 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';

// React Compiler configuration
// Set VITE_DISABLE_REACT_COMPILER=1 to disable for WDYR profiling:
//   $env:VITE_DISABLE_REACT_COMPILER="1"; bun run dev
const enableReactCompiler = !process.env.VITE_DISABLE_REACT_COMPILER;
const ReactCompilerConfig = {
	// Target React 19 (default, can be omitted)
	// target: '19',
};

/**
 * Vite plugin to serve session dump files from docs/debug/ via HTTP.
 * This allows fetch('/docs/debug/ses_xxx.json') to work in dev mode.
 */
function serveDumpsPlugin() {
	const docsRoot = resolve(__dirname, 'docs');
	return {
		name: 'serve-session-dumps',
		configureServer(server: { middlewares: { use: (fn: Function) => void } }) {
			server.middlewares.use(
				(
					req: { url?: string },
					res: { setHeader: Function; end: Function; statusCode: number },
					next: Function,
				) => {
					if (req.url?.startsWith('/docs/')) {
						const filePath = resolve(docsRoot, req.url.replace('/docs/', ''));
						if (existsSync(filePath)) {
							res.setHeader('Content-Type', 'application/json');
							res.setHeader('Access-Control-Allow-Origin', '*');
							res.end(readFileSync(filePath, 'utf-8'));
							return;
						}
					}
					next();
				},
			);
		},
	};
}

export default defineConfig({
	plugins: [
		react({
			// WDYR требует classic JSX transform (createElement вместо jsx/jsxs)
			// При отключённом React Compiler переключаемся на classic
			...(enableReactCompiler ? {} : { jsxRuntime: 'classic' }),
			babel: {
				plugins: enableReactCompiler ? [['babel-plugin-react-compiler', ReactCompilerConfig]] : [],
			},
		}),
		tailwindcss(),
		serveDumpsPlugin(),
	],
	root: resolve(__dirname, 'src/webview/dev'),
	publicDir: resolve(__dirname, 'public'),
	server: {
		port: 5173,
		open: true,
		host: true,
		fs: {
			allow: [resolve(__dirname)],
		},
	},
	build: {
		outDir: resolve(__dirname, 'dev-dist'),
		emptyOutDir: true,
	},
});
