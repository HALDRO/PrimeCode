import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const IS_WINDOWS = process.platform.startsWith('win');
const BIN_NAME = IS_WINDOWS ? 'rg.exe' : 'rg';

/**
 * Get the path to the ripgrep binary within the VS Code installation
 */
export async function getBinPath(vscodeAppRoot: string): Promise<string | undefined> {
	const checkPath = async (pkgFolder: string): Promise<string | undefined> => {
		const fullPath = path.join(vscodeAppRoot, pkgFolder, BIN_NAME);
		try {
			await fs.promises.access(fullPath, fs.constants.X_OK);
			return fullPath;
		} catch {
			return undefined;
		}
	};

	const paths = [
		'node_modules/@vscode/ripgrep/bin/',
		'node_modules/vscode-ripgrep/bin',
		'node_modules.asar.unpacked/vscode-ripgrep/bin/',
		'node_modules.asar.unpacked/@vscode/ripgrep/bin/',
	];

	for (const p of paths) {
		const binPath = await checkPath(p);
		if (binPath) return binPath;
	}

	return undefined;
}

/**
 * Get ripgrep binary path using VS Code's app root
 */
export async function getRipgrepPath(): Promise<string | undefined> {
	return getBinPath(vscode.env.appRoot);
}
