/**
 * Mock VSCode API for Vitest tests
 * Based on Kilocode's vscode mock
 */

const mockEventEmitter = () => ({
	event: () => () => {},
	fire: () => {},
	dispose: () => {},
});

const mockDisposable = {
	dispose: () => {},
};

const mockUri = {
	file: (path: string) => ({ fsPath: path, path, scheme: 'file', toString: () => path }),
	parse: (path: string) => ({ fsPath: path, path, scheme: 'file', toString: () => path }),
	joinPath: (base: { fsPath: string }, ...pathSegments: string[]) => {
		const joined = [base.fsPath, ...pathSegments].join('/');
		return { fsPath: joined, path: joined, scheme: 'file', toString: () => joined };
	},
};

class MockRange {
	constructor(
		public start: MockPosition,
		public end: MockPosition,
	) {}
}

class MockPosition {
	constructor(
		public line: number,
		public character: number,
	) {}
}

class MockSelection extends MockRange {
	anchor: MockPosition;
	active: MockPosition;

	constructor(start: MockPosition, end: MockPosition) {
		super(start, end);
		this.anchor = start;
		this.active = end;
	}
}

/**
 * Creates a mock configuration object with customizable values
 */
export const createMockConfiguration = (values: Record<string, unknown> = {}) => ({
	get: <T>(key: string, defaultValue?: T): T | undefined => {
		if (key in values) {
			return values[key] as T;
		}
		return defaultValue;
	},
	update: () => Promise.resolve(),
	has: (key: string) => key in values,
	inspect: () => undefined,
});

export const workspace = {
	workspaceFolders: [],
	getWorkspaceFolder: () => null,
	onDidChangeWorkspaceFolders: () => mockDisposable,
	getConfiguration: (_section?: string) => createMockConfiguration(),
	createFileSystemWatcher: () => ({
		onDidCreate: () => mockDisposable,
		onDidChange: () => mockDisposable,
		onDidDelete: () => mockDisposable,
		dispose: () => {},
	}),
	fs: {
		readFile: () => Promise.resolve(new Uint8Array()),
		writeFile: () => Promise.resolve(),
		stat: () => Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: 0 }),
		readDirectory: () => Promise.resolve([]),
		createDirectory: () => Promise.resolve(),
		delete: () => Promise.resolve(),
	},
	onDidChangeConfiguration: () => mockDisposable,
};

export const window = {
	activeTextEditor: null,
	onDidChangeActiveTextEditor: () => mockDisposable,
	showErrorMessage: () => Promise.resolve(),
	showWarningMessage: () => Promise.resolve(),
	showInformationMessage: () => Promise.resolve(),
	createOutputChannel: () => ({
		appendLine: () => {},
		append: () => {},
		clear: () => {},
		show: () => {},
		dispose: () => {},
	}),
	createTerminal: () => ({
		exitStatus: undefined,
		name: 'Test Terminal',
		processId: Promise.resolve(123),
		creationOptions: {},
		state: { isInteractedWith: true },
		dispose: () => {},
		hide: () => {},
		show: () => {},
		sendText: () => {},
	}),
	onDidCloseTerminal: () => mockDisposable,
	createTextEditorDecorationType: () => ({ dispose: () => {} }),
};

export const commands = {
	registerCommand: () => mockDisposable,
	executeCommand: () => Promise.resolve(),
};

export const languages = {
	createDiagnosticCollection: () => ({
		set: () => {},
		delete: () => {},
		clear: () => {},
		dispose: () => {},
	}),
};

export const extensions = {
	getExtension: () => null,
};

export const env = {
	openExternal: () => Promise.resolve(),
};

export const Uri = mockUri;
export const Range = MockRange;
export const Position = MockPosition;
export const Selection = MockSelection;
export const Disposable = mockDisposable;

export class ThemeIcon {
	constructor(public id: string) {}
}

export class ThemeColor {
	constructor(public id: string) {}
}

export const FileType = {
	File: 1,
	Directory: 2,
	SymbolicLink: 64,
};

export const DiagnosticSeverity = {
	Error: 0,
	Warning: 1,
	Information: 2,
	Hint: 3,
};

export const ConfigurationTarget = {
	Global: 1,
	Workspace: 2,
	WorkspaceFolder: 3,
};

export const ViewColumn = {
	Active: -1,
	Beside: -2,
	One: 1,
	Two: 2,
	Three: 3,
	Four: 4,
	Five: 5,
	Six: 6,
	Seven: 7,
	Eight: 8,
	Nine: 9,
};

export const StatusBarAlignment = {
	Left: 1,
	Right: 2,
};

export const EventEmitter = mockEventEmitter;

/**
 * Creates a mock ExtensionContext for testing
 * @param overrides - Optional overrides for specific properties
 */
export const createMockExtensionContext = (overrides: Record<string, unknown> = {}) => {
	const globalStateData: Record<string, unknown> = {};
	const workspaceStateData: Record<string, unknown> = {};
	const secretsData: Record<string, string> = {};

	return {
		subscriptions: [],
		extensionPath: '/mock/extension/path',
		extensionUri: mockUri.file('/mock/extension/path'),
		storagePath: '/mock/storage/path',
		storageUri: mockUri.file('/mock/storage/path'),
		globalStoragePath: '/mock/global/storage/path',
		globalStorageUri: mockUri.file('/mock/global/storage/path'),
		logPath: '/mock/log/path',
		logUri: mockUri.file('/mock/log/path'),
		extensionMode: 2, // ExtensionMode.Development
		globalState: {
			get: <T>(key: string, defaultValue?: T): T | undefined =>
				(globalStateData[key] as T) ?? defaultValue,
			update: (key: string, value: unknown) => {
				globalStateData[key] = value;
				return Promise.resolve();
			},
			keys: () => Object.keys(globalStateData),
			setKeysForSync: () => {},
		},
		workspaceState: {
			get: <T>(key: string, defaultValue?: T): T | undefined =>
				(workspaceStateData[key] as T) ?? defaultValue,
			update: (key: string, value: unknown) => {
				workspaceStateData[key] = value;
				return Promise.resolve();
			},
			keys: () => Object.keys(workspaceStateData),
		},
		secrets: {
			get: (key: string) => Promise.resolve(secretsData[key]),
			store: (key: string, value: string) => {
				secretsData[key] = value;
				return Promise.resolve();
			},
			delete: (key: string) => {
				delete secretsData[key];
				return Promise.resolve();
			},
			onDidChange: () => mockDisposable,
		},
		asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
		environmentVariableCollection: {
			persistent: true,
			description: 'Mock env collection',
			replace: () => {},
			append: () => {},
			prepend: () => {},
			get: () => undefined,
			forEach: () => {},
			delete: () => {},
			clear: () => {},
			getScoped: () => ({}),
		},
		extension: {
			id: 'mock.extension',
			extensionUri: mockUri.file('/mock/extension/path'),
			extensionPath: '/mock/extension/path',
			isActive: true,
			packageJSON: { name: 'mock-extension', version: '1.0.0' },
			exports: undefined,
			activate: () => Promise.resolve(),
			extensionKind: 1,
		},
		...overrides,
	};
};

export default {
	workspace,
	window,
	commands,
	languages,
	extensions,
	env,
	Uri,
	Range,
	Position,
	Selection,
	Disposable,
	ThemeIcon,
	ThemeColor,
	FileType,
	DiagnosticSeverity,
	ConfigurationTarget,
	ViewColumn,
	StatusBarAlignment,
	EventEmitter,
	// Helper functions for tests
	createMockExtensionContext,
	createMockConfiguration,
};
