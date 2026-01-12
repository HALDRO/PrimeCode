import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		exclude: ['node_modules', 'out', 'dist', 'docs', 'src/__tests__/vscode/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.{test,spec}.ts', 'src/webview/**'],
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src'),
			'@src': path.resolve(__dirname, 'src'),
			'vscode': path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
		},
	},
});
