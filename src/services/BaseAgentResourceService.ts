/**
 * @file BaseAgentResourceService
 * @description Abstract base class for agent resource services (commands, skills, hooks, subagents).
 *              Eliminates duplicated CRUD logic across AgentsCommandsService, AgentsSkillsService,
 *              AgentsHooksService, and AgentsSubagentsService. Uses vscode.workspace.fs for
 *              Remote Development compatibility (SSH, WSL, Dev Containers).
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { normalizeToPosixPath } from '../utils/path';

// =============================================================================
// Abstract Base Class
// =============================================================================

export abstract class BaseAgentResourceService<T extends { name: string; path: string }> {
	protected _workspaceRoot: string | undefined;

	/** Relative path from workspace root to the canonical resource directory. */
	protected abstract readonly resourceDir: string;

	/** Parse raw frontmatter attributes + body into a typed resource item. */
	protected abstract parseResource(
		attributes: Record<string, string | boolean>,
		body: string,
		fileName: string,
	): T;

	/** Serialize a resource item into frontmatter attributes + body. */
	protected abstract stringifyResource(item: Partial<T> & { name: string }): {
		attributes: Record<string, string | boolean | undefined>;
		body: string;
	};

	public setWorkspaceRoot(root: string): void {
		this._workspaceRoot = root;
	}

	protected get workspaceRoot(): string {
		if (!this._workspaceRoot) throw new Error('Workspace root not set');
		return this._workspaceRoot;
	}

	// =========================================================================
	// VS Code FS Helpers (Remote Development compatible)
	// =========================================================================

	protected dirUri(relativePath?: string): vscode.Uri {
		const base = relativePath ?? this.resourceDir;
		return vscode.Uri.file(path.join(this.workspaceRoot, base));
	}

	protected async ensureDir(uri: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(uri);
		} catch {
			// Directory may already exist
		}
	}

	protected async readTextFile(uri: vscode.Uri): Promise<string> {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(bytes);
	}

	protected async writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	}

	protected async fileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	protected async deleteFileOrDir(uri: vscode.Uri, recursive = false): Promise<void> {
		try {
			await vscode.workspace.fs.delete(uri, { recursive });
		} catch (e) {
			if ((e as vscode.FileSystemError).code !== 'FileNotFound') throw e;
		}
	}

	// =========================================================================
	// Generic CRUD — flat .md files (commands, hooks, subagents)
	// =========================================================================

	/**
	 * Get the filename for a resource. Override for custom naming (e.g. hookify convention).
	 */
	protected getFileName(name: string): string {
		return `${name}.md`;
	}

	/**
	 * Extract the resource name from a filename. Override if getFileName is overridden.
	 */
	protected getNameFromFileName(fileName: string): string {
		return fileName.replace(/\.md$/, '');
	}

	/**
	 * Read all resources from the canonical directory.
	 * Override for non-flat layouts (e.g. skills use subdirectories).
	 */
	public async getAll(): Promise<T[]> {
		if (!this._workspaceRoot) return [];
		const dir = this.dirUri();
		await this.ensureDir(dir);

		try {
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const items: T[] = [];

			for (const [name, type] of entries) {
				if (type !== vscode.FileType.File || !name.endsWith('.md')) continue;
				try {
					const uri = vscode.Uri.joinPath(dir, name);
					const content = await this.readTextFile(uri);
					const { attributes, body } = parseFrontmatter(content);
					items.push(this.parseResource(attributes, body, name));
				} catch {
					// Skip broken files
				}
			}

			return items.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return [];
		}
	}

	/**
	 * Save a resource to the canonical directory.
	 * Override for non-flat layouts.
	 */
	public async save(item: Partial<T> & { name: string }): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this.sanitizeName(item.name);
		const dir = this.dirUri();
		await this.ensureDir(dir);

		const { attributes, body } = this.stringifyResource({ ...item, name: safeName });
		const content = stringifyFrontmatter(attributes, body);
		const uri = vscode.Uri.joinPath(dir, this.getFileName(safeName));
		await this.writeTextFile(uri, content);
	}

	/**
	 * Delete a resource from the canonical directory.
	 * Override for non-flat layouts.
	 */
	public async delete(name: string): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this.sanitizeName(name);
		const uri = vscode.Uri.joinPath(this.dirUri(), this.getFileName(safeName));
		await this.deleteFileOrDir(uri);
	}

	// =========================================================================
	// Import / Sync Helpers
	// =========================================================================

	/**
	 * Import .md files from a source directory into the canonical directory.
	 * Only imports files that don't already exist in the target.
	 */
	protected async importFromFlatDir(sourceRelative: string): Promise<number> {
		if (!this._workspaceRoot) return 0;
		const sourceUri = this.dirUri(sourceRelative);
		const targetUri = this.dirUri();

		try {
			await vscode.workspace.fs.stat(sourceUri);
		} catch {
			return 0; // Source doesn't exist
		}

		await this.ensureDir(targetUri);
		const entries = await vscode.workspace.fs.readDirectory(sourceUri);
		let count = 0;

		for (const [name, type] of entries) {
			if (type !== vscode.FileType.File || !name.endsWith('.md')) continue;
			const targetFileUri = vscode.Uri.joinPath(targetUri, name);
			if (await this.fileExists(targetFileUri)) continue;

			const sourceFileUri = vscode.Uri.joinPath(sourceUri, name);
			const content = await this.readTextFile(sourceFileUri);
			await this.writeTextFile(targetFileUri, content);
			count++;
		}

		return count;
	}

	/**
	 * Sync all resources to a target CLI directory (flat .md files).
	 */
	protected async syncToFlatDir(
		targetRelative: string,
		transform?: (item: T) => string,
	): Promise<number> {
		if (!this._workspaceRoot) return 0;
		const items = await this.getAll();
		const targetUri = this.dirUri(targetRelative);
		await this.ensureDir(targetUri);

		let synced = 0;
		for (const item of items) {
			const content = transform
				? transform(item)
				: (() => {
						const { attributes, body } = this.stringifyResource(
							item as Partial<T> & { name: string },
						);
						return stringifyFrontmatter(attributes, body);
					})();
			const fileName = this.getFileName(this.sanitizeName(item.name));
			const uri = vscode.Uri.joinPath(targetUri, fileName);
			await this.writeTextFile(uri, content);
			synced++;
		}

		return synced;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	protected sanitizeName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed) throw new Error('Resource name is required');
		return trimmed.replace(/[\\/:*?"<>|]/g, '-');
	}

	protected buildRelativePath(...segments: string[]): string {
		return normalizeToPosixPath(path.join(this.resourceDir, ...segments));
	}
}
