import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => await import('../../__mocks__/vscode.js'));

import * as vscode from 'vscode';
import { ConfigFileWatcherService } from '../ConfigFileWatcherService';
import { ResourceWatcherService } from '../ResourceWatcherService';

describe('watcher lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('resource watcher can restart after missing initial workspace root', () => {
		(vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [];
		const service = new ResourceWatcherService();
		const spy = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');

		service.start(() => {});
		expect(spy).not.toHaveBeenCalled();

		(
			vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> }
		).workspaceFolders = [{ uri: { fsPath: 'C:\\repo' } }];
		service.dispose();
		service.start(() => {});

		expect(spy).toHaveBeenCalled();
	});

	it('mcp watcher can restart after missing initial workspace root', () => {
		(vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [];
		const service = new ConfigFileWatcherService();
		const spy = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');

		service.start(() => {});
		expect(spy).not.toHaveBeenCalled();

		(
			vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> }
		).workspaceFolders = [{ uri: { fsPath: 'C:\\repo' } }];
		service.dispose();
		service.start(() => {});

		expect(spy).toHaveBeenCalled();
	});
});
