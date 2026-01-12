/**
 * @file Workspace file search utilities using ripgrep
 * @description Provides fast file search functionality using ripgrep binary.
 * Supports fuzzy matching and directory traversal with configurable exclusions.
 * Integrates with ErrorService for centralized error handling.
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { EXCLUDE_PATTERNS } from '../shared/constants';
import { ErrorCode, errorService, FileSystemError, ProcessError } from './ErrorService';
import { getBinPath } from './ripgrep';

export interface FileSearchResult {
	path: string;
	type: 'file' | 'folder';
	label: string;
}

/**
 * Search workspace files with fuzzy matching
 */
export async function searchWorkspaceFiles(
	query: string,
	workspacePath: string,
	limit = 50,
): Promise<FileSearchResult[]> {
	try {
		const allItems = await getAllWorkspaceFiles(workspacePath, 5000);

		if (!query.trim()) {
			return allItems
				.sort((a, b) => a.path.length - b.path.length || a.label.localeCompare(b.label))
				.slice(0, limit);
		}

		const scoredItems = allItems
			.map(item => {
				const labelMatch = fuzzyMatch(query, item.label);
				const pathMatch = fuzzyMatch(query, item.path);
				const bestScore = Math.max(labelMatch.score, pathMatch.score);

				return {
					item,
					score: bestScore,
					match: labelMatch.match || pathMatch.match,
				};
			})
			.filter(x => x.match)
			.sort((a, b) => {
				if (b.score !== a.score) {
					return b.score - a.score;
				}
				return a.item.path.length - b.item.path.length;
			});

		const results = await Promise.all(
			scoredItems.slice(0, limit).map(async ({ item }) => {
				const fullPath = path.join(workspacePath, item.path);
				try {
					const stat = await fs.promises.stat(fullPath);
					return {
						...item,
						type: stat.isDirectory() ? ('folder' as const) : ('file' as const),
					};
				} catch {
					return item;
				}
			}),
		);

		return results;
	} catch (error) {
		const fsError = FileSystemError.fromNodeError(error as NodeJS.ErrnoException, workspacePath);
		errorService.handle(fsError, 'fileSearch.searchWorkspaceFiles');
		return [];
	}
}

/**
 * Get workspace path from VS Code
 */
export function getWorkspacePath(): string | undefined {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return undefined;
	}
	return workspaceFolders[0].uri.fsPath;
}

/**
 * Execute ripgrep to list files in workspace
 */
async function executeRipgrep(
	args: string[],
	workspacePath: string,
	limit = 500,
): Promise<FileSearchResult[]> {
	const rgPath = await getBinPath(vscode.env.appRoot);

	if (!rgPath) {
		const processError = new ProcessError('Ripgrep binary not found', ErrorCode.CLI_NOT_FOUND, {
			tool: 'ripgrep',
		});
		errorService.handle(processError, 'fileSearch.executeRipgrep');
		return [];
	}

	return new Promise(resolve => {
		const rgProcess = cp.spawn(rgPath, args);
		const rl = readline.createInterface({
			input: rgProcess.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		const fileResults: FileSearchResult[] = [];
		const dirSet = new Set<string>();

		let count = 0;

		rl.on('line', line => {
			if (count < limit) {
				try {
					const relativePath = path.relative(workspacePath, line);

					if (!relativePath || relativePath.startsWith('..')) {
						return;
					}

					fileResults.push({
						path: relativePath.replace(/\\/g, '/'),
						type: 'file',
						label: path.basename(relativePath),
					});

					let dirPath = path.dirname(relativePath);
					while (dirPath && dirPath !== '.' && dirPath !== '/') {
						dirSet.add(dirPath);
						dirPath = path.dirname(dirPath);
					}

					count++;
				} catch {
					// Ignore individual path processing errors
				}
			} else {
				rl.close();
				rgProcess.kill();
			}
		});

		rl.on('close', () => {
			const dirResults: FileSearchResult[] = Array.from(dirSet).map(dirPath => ({
				path: dirPath.replace(/\\/g, '/'),
				type: 'folder',
				label: path.basename(dirPath),
			}));

			resolve([...fileResults, ...dirResults]);
		});

		rgProcess.on('error', error => {
			const processError = ProcessError.fromSpawnError(error);
			errorService.handle(processError, 'fileSearch.executeRipgrep.spawn');
			resolve([]);
		});
	});
}

/**
 * Get all files in workspace using ripgrep
 */
async function getAllWorkspaceFiles(
	workspacePath: string,
	limit = 5000,
): Promise<FileSearchResult[]> {
	const args = ['--files', '--follow', '--hidden', ...EXCLUDE_PATTERNS.RIPGREP_ARGS, workspacePath];

	return executeRipgrep(args, workspacePath, limit);
}

/**
 * Simple fuzzy match function
 */
function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	if (textLower === queryLower) {
		return { match: true, score: 1000 };
	}

	if (textLower.startsWith(queryLower)) {
		return { match: true, score: 500 };
	}

	if (textLower.includes(queryLower)) {
		return { match: true, score: 100 };
	}

	let queryIdx = 0;
	let score = 0;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIdx < queryLower.length; i++) {
		if (textLower[i] === queryLower[queryIdx]) {
			queryIdx++;
			consecutiveMatches++;
			score += consecutiveMatches * 2;
		} else {
			consecutiveMatches = 0;
		}
	}

	if (queryIdx === queryLower.length) {
		return { match: true, score };
	}

	return { match: false, score: 0 };
}
