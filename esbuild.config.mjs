import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
	entryPoints: ['./src/extension.ts'],
	bundle: true,
	outfile: './out/extension.js',
	external: [
		'vscode', // vscode is provided by VS Code runtime
		'@anthropic-ai/claude-agent-sdk', // SDK uses import.meta.url which breaks when bundled to CJS
	],
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	sourcemap: !production,
	minify: production,
	treeShaking: true,
};

async function main() {
	if (watch) {
		const ctx = await esbuild.context(extensionConfig);
		await ctx.watch();
		console.log('Watching for changes...');
	} else {
		await esbuild.build(extensionConfig);
		console.log('Extension bundled successfully!');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
