/**
 * @file OpenCode Find Operations
 * @description Handles search and file lookup operations (text search, file search, symbols, LSP).
 * Extends BaseOpenCodeOps for unified error handling and reduced boilerplate.
 * Uses Context Accessor pattern for safe state access.
 * Updated for SDK v2 flat parameter style.
 */

import { BaseOpenCodeOps } from './BaseOpenCodeOps.js';

/** Text search result from ripgrep */
export interface TextSearchResult {
	path: string;
	lineNumber: number;
	text: string;
	matches: Array<{ text: string; start: number; end: number }>;
}

/** Symbol search result from LSP */
export interface SymbolSearchResult {
	name: string;
	kind: number;
	location: {
		uri: string;
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
	};
}

/** File listing entry */
export interface FileListEntry {
	name: string;
	path: string;
	absolute: string;
	type: 'file' | 'directory';
	ignored: boolean;
}

/** File content result */
export interface FileContent {
	type: 'text';
	content: string;
	diff?: string;
	mimeType?: string;
}

/** Command definition */
export interface CommandDefinition {
	name: string;
	description?: string;
	agent?: string;
	model?: string;
	template: string;
	subtask?: boolean;
}

/** LSP server status */
export interface LspServerStatus {
	id: string;
	name: string;
	root: string;
	status: 'connected' | 'error';
}

/** Formatter status */
export interface FormatterStatus {
	name: string;
	extensions: string[];
	enabled: boolean;
}

/** Raw ripgrep result from SDK */
interface RawTextSearchResult {
	path: { text: string };
	line_number: number;
	lines: { text: string };
	submatches: Array<{ match: { text: string }; start: number; end: number }>;
}

export class OpenCodeFindOps extends BaseOpenCodeOps {
	// =========================================================================
	// Text & File Search
	// =========================================================================

	/**
	 * Search for text patterns across files using ripgrep
	 */
	public async findText(pattern: string): Promise<TextSearchResult[] | null> {
		return this.safeExecute<RawTextSearchResult[], TextSearchResult[]>(
			`Find text: "${pattern}"`,
			client =>
				client.find.text({
					directory: this._workspaceDir,
					pattern,
				}),
			data =>
				(data || []).map(r => ({
					path: r.path.text,
					lineNumber: r.line_number,
					text: r.lines.text,
					matches: r.submatches.map(m => ({
						text: m.match.text,
						start: m.start,
						end: m.end,
					})),
				})),
		);
	}

	/**
	 * Search for files by name or pattern
	 */
	public async findFiles(query: string, includeDirs = false): Promise<string[] | null> {
		return this.safeExecute<string[], string[]>(
			`Find files: "${query}"`,
			client =>
				client.find.files({
					directory: this._workspaceDir,
					query,
					dirs: includeDirs ? 'true' : 'false',
				}),
			data => data || [],
		);
	}

	/**
	 * Search for workspace symbols (functions, classes, variables) using LSP
	 */
	public async findSymbols(query: string): Promise<SymbolSearchResult[] | null> {
		return this.safeExecute<SymbolSearchResult[], SymbolSearchResult[]>(
			`Find symbols: "${query}"`,
			client =>
				client.find.symbols({
					directory: this._workspaceDir,
					query,
				}),
			data => data || [],
		);
	}

	// =========================================================================
	// File Operations
	// =========================================================================

	/**
	 * List files and directories in a path
	 */
	public async listFiles(filePath: string): Promise<FileListEntry[] | null> {
		return this.safeExecute<FileListEntry[], FileListEntry[]>(
			`List files: "${filePath}"`,
			client =>
				client.file.list({
					directory: this._workspaceDir,
					path: filePath,
				}),
			data => data || [],
		);
	}

	/**
	 * Read file content
	 */
	public async readFile(filePath: string): Promise<FileContent | null> {
		return this.safeExecute<FileContent, FileContent>(`Read file: "${filePath}"`, client =>
			client.file.read({
				directory: this._workspaceDir,
				path: filePath,
			}),
		);
	}

	// =========================================================================
	// Commands & Tools
	// =========================================================================

	/**
	 * Get list of available commands
	 */
	public async getCommands(): Promise<CommandDefinition[] | null> {
		return this.safeExecute<CommandDefinition[], CommandDefinition[]>(
			'Get commands',
			client =>
				client.command.list({
					directory: this._workspaceDir,
				}),
			data => data || [],
		);
	}

	// =========================================================================
	// LSP & Formatter Status
	// =========================================================================

	/**
	 * Get LSP server status
	 */
	public async getLspStatus(): Promise<LspServerStatus[] | null> {
		return this.safeExecute<LspServerStatus[], LspServerStatus[]>(
			'Get LSP status',
			client =>
				client.lsp.status({
					directory: this._workspaceDir,
				}),
			data => data || [],
		);
	}

	/**
	 * Get formatter status
	 */
	public async getFormatterStatus(): Promise<FormatterStatus[] | null> {
		return this.safeExecute<FormatterStatus[], FormatterStatus[]>(
			'Get formatter status',
			client =>
				client.formatter.status({
					directory: this._workspaceDir,
				}),
			data => data || [],
		);
	}

	// =========================================================================
	// VCS & File Status
	// =========================================================================

	/**
	 * Get VCS (git) information for the current project
	 */
	public async getVcsInfo(): Promise<{ branch?: string } | null> {
		return this.safeExecute<{ branch?: string }, { branch?: string }>(
			'Get VCS info',
			client =>
				client.vcs.get({
					directory: this._workspaceDir,
				}),
			data => ({ branch: data?.branch }),
		);
	}

	/**
	 * Get git status of all files in the project
	 */
	public async getFileStatus(): Promise<Array<{
		path: string;
		added: number;
		removed: number;
		status: 'added' | 'deleted' | 'modified';
	}> | null> {
		return this.safeExecute(
			'Get file status',
			client =>
				client.file.status({
					directory: this._workspaceDir,
				}),
			data => data || [],
		);
	}
}
