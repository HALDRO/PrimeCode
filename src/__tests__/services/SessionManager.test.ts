/**
 * @file SessionManager Tests
 * @description Tests for SessionManager - multi-session orchestration, persistence,
 * session lifecycle, and provider type handling across sessions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionManagerEvents } from '../../services/SessionManager';

// Mock CLIServiceFactory
vi.mock('../../services/CLIServiceFactory', () => ({
	CLIServiceFactory: {
		getCurrentProvider: vi.fn().mockReturnValue('opencode'),
		getService: vi.fn().mockResolvedValue({
			getProviderType: () => 'opencode',
			initialize: vi.fn().mockResolvedValue(undefined),
			createSession: vi.fn().mockResolvedValue('ses_mock123'),
			switchSession: vi.fn().mockResolvedValue({ id: 'ses_mock123', title: 'Test' }),
			stopProcess: vi.fn().mockReturnValue(true),
			dispose: vi.fn().mockResolvedValue(undefined),
		}),
	},
}));

// Mock ConversationService
vi.mock('../../services/ConversationService', () => ({
	ConversationService: class MockConversationService {
		waitForInitialization = vi.fn().mockResolvedValue(undefined);
		loadConversation = vi.fn().mockResolvedValue(null);
		saveConversation = vi.fn().mockResolvedValue(undefined);
	},
}));

// Mock BackupService
vi.mock('../../services/BackupService', () => ({
	BackupService: class MockBackupService {
		setActiveSession = vi.fn();
		createBackupCommit = vi.fn().mockResolvedValue(null);
		restoreToCommit = vi.fn().mockResolvedValue({ success: true, message: 'OK' });
		clearSessionCommits = vi.fn();
	},
}));

// Mock vscode ExtensionContext
const createMockContext = () => {
	const globalStateData: Record<string, unknown> = {};
	return {
		globalState: {
			get: vi.fn((key: string, defaultValue?: unknown) => globalStateData[key] ?? defaultValue),
			update: vi.fn((key: string, value: unknown) => {
				globalStateData[key] = value;
				return Promise.resolve();
			}),
		},
		workspaceState: {
			get: vi.fn(),
			update: vi.fn().mockResolvedValue(undefined),
		},
		extensionPath: '/mock/extension/path',
		storagePath: '/mock/storage/path',
		globalStoragePath: '/mock/global/storage/path',
		subscriptions: [],
	};
};

// Mock events
const createMockEvents = (): SessionManagerEvents => ({
	onSessionCreated: vi.fn(),
	onSessionClosed: vi.fn(),
	onSessionData: vi.fn(),
	onSessionClose: vi.fn(),
	onSessionError: vi.fn(),
	onCommitCreated: vi.fn(),
});

describe('SessionManager', () => {
	let context: ReturnType<typeof createMockContext>;
	let events: SessionManagerEvents;
	let manager: SessionManager;

	beforeEach(() => {
		context = createMockContext();
		events = createMockEvents();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		if (manager) {
			await manager.dispose();
		}
	});

	describe('Initialization', () => {
		it('should initialize with no sessions', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			expect(manager.sessionCount).toBe(0);
			expect(manager.activeSessionId).toBeUndefined();
		});

		it('should only initialize once', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });

			await manager.initialize();
			await manager.initialize(); // Second call should be no-op

			expect(manager.sessionCount).toBe(0);
		});
	});

	describe('Session Creation', () => {
		it('should create a new session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const sessionId = await manager.createSession();

			expect(sessionId).toBeDefined();
			expect(sessionId).toMatch(/^session-\d+-/);
			expect(manager.sessionCount).toBe(1);
			expect(events.onSessionCreated).toHaveBeenCalledWith(sessionId);
		});

		it('should create session with custom ID', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const customId = 'my-custom-session-id';
			const sessionId = await manager.createSession(customId);

			expect(sessionId).toBe(customId);
			expect(manager.getSession(customId)).toBeDefined();
		});

		it('should set first session as active', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const sessionId = await manager.createSession();

			expect(manager.activeSessionId).toBe(sessionId);
		});

		it('should not duplicate existing session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const sessionId = await manager.createSession('test-session');
			const sessionId2 = await manager.createSession('test-session');

			expect(sessionId).toBe(sessionId2);
			expect(manager.sessionCount).toBe(1);
		});

		it('should respect max sessions limit', async () => {
			manager = new SessionManager(context as any, events, {
				persistSessions: false,
				maxSessions: 2,
			});
			await manager.initialize();

			await manager.createSession('session-1');
			await manager.createSession('session-2');

			// Third session should close oldest idle session
			await manager.createSession('session-3');

			expect(manager.sessionCount).toBe(2);
		});
	});

	describe('Session Switching', () => {
		it('should switch active session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const session1 = await manager.createSession('session-1');
			const session2 = await manager.createSession('session-2');

			expect(manager.activeSessionId).toBe(session1); // First is active

			manager.switchSession(session2);

			expect(manager.activeSessionId).toBe(session2);
		});

		it('should return undefined for non-existent session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const result = manager.switchSession('non-existent');

			expect(result).toBeUndefined();
		});

		it('should mark session as active on switch', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('session-1');
			const session = manager.getSession('session-1');
			const initialLastActive = session?.lastActiveAt ?? 0;

			// Wait a bit to ensure timestamp changes
			await new Promise(resolve => setTimeout(resolve, 10));

			manager.switchSession('session-1');

			expect(session?.lastActiveAt).toBeGreaterThanOrEqual(initialLastActive);
		});
	});

	describe('Session Access', () => {
		it('should get session by ID', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('test-session');
			const session = manager.getSession('test-session');

			expect(session).toBeDefined();
			expect(session?.uiSessionId).toBe('test-session');
		});

		it('should get active session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('test-session');
			const activeSession = manager.getActiveSession();

			expect(activeSession).toBeDefined();
			expect(activeSession?.uiSessionId).toBe('test-session');
		});

		it('should get all sessions', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('session-1');
			await manager.createSession('session-2');

			const allSessions = manager.getAllSessions();

			expect(allSessions).toHaveLength(2);
		});

		it('should get or create session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			// Should create new session
			const session1 = await manager.getOrCreateSession('new-session');
			expect(session1.uiSessionId).toBe('new-session');

			// Should return existing session
			const session2 = await manager.getOrCreateSession('new-session');
			expect(session2).toBe(session1);
		});
	});

	describe('Session Closing', () => {
		it('should close session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('test-session');
			const closed = await manager.closeSession('test-session');

			expect(closed).toBe(true);
			expect(manager.sessionCount).toBe(0);
			expect(events.onSessionClosed).toHaveBeenCalledWith('test-session');
		});

		it('should update active session when closing active', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('session-1');
			await manager.createSession('session-2');

			expect(manager.activeSessionId).toBe('session-1');

			await manager.closeSession('session-1');

			expect(manager.activeSessionId).toBe('session-2');
		});

		it('should return false for non-existent session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const closed = await manager.closeSession('non-existent');

			expect(closed).toBe(false);
		});

		it('should close all sessions', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('session-1');
			await manager.createSession('session-2');
			await manager.createSession('session-3');

			await manager.closeAllSessions();

			expect(manager.sessionCount).toBe(0);
		});
	});

	describe('ensureActiveSession', () => {
		it('should return existing active session', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('existing-session');
			const session = await manager.ensureActiveSession();

			expect(session.uiSessionId).toBe('existing-session');
		});

		it('should create new session if none exists', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			const session = await manager.ensureActiveSession();

			expect(session).toBeDefined();
			expect(manager.sessionCount).toBe(1);
		});

		it('should handle concurrent calls safely', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			// Call ensureActiveSession multiple times concurrently
			const [session1, session2, session3] = await Promise.all([
				manager.ensureActiveSession(),
				manager.ensureActiveSession(),
				manager.ensureActiveSession(),
			]);

			// All should return the same session
			expect(session1).toBe(session2);
			expect(session2).toBe(session3);
			expect(manager.sessionCount).toBe(1);
		});
	});

	describe('Processing State', () => {
		it('should check if any session is processing', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('test-session');
			const session = manager.getSession('test-session');

			expect(manager.isAnySessionProcessing()).toBe(false);

			session?.setProcessing(true);

			expect(manager.isAnySessionProcessing()).toBe(true);
		});

		it('should get processing sessions', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('session-1');
			await manager.createSession('session-2');

			manager.getSession('session-1')?.setProcessing(true);

			const processingSessions = manager.getProcessingSessions();

			expect(processingSessions).toHaveLength(1);
			expect(processingSessions[0].uiSessionId).toBe('session-1');
		});
	});

	describe('Snapshots', () => {
		it('should get snapshots of all sessions', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('session-1');
			await manager.createSession('session-2');

			// Set provider types
			manager.getSession('session-1')?.setProviderType('opencode');
			manager.getSession('session-2')?.setProviderType('claude');

			const snapshots = manager.getSnapshots();

			expect(snapshots).toHaveLength(2);
			expect(snapshots.find(s => s.uiSessionId === 'session-1')?.providerType).toBe('opencode');
			expect(snapshots.find(s => s.uiSessionId === 'session-2')?.providerType).toBe('claude');
		});
	});

	describe('Multi-Provider Support', () => {
		it('should support different providers in different sessions', async () => {
			manager = new SessionManager(context as any, events, { persistSessions: false });
			await manager.initialize();

			await manager.createSession('opencode-session');
			await manager.createSession('claude-session');

			const opencodeSession = manager.getSession('opencode-session');
			const claudeSession = manager.getSession('claude-session');

			opencodeSession?.setProviderType('opencode');
			claudeSession?.setProviderType('claude');

			expect(opencodeSession?.providerType).toBe('opencode');
			expect(claudeSession?.providerType).toBe('claude');

			// Switching sessions should preserve provider types
			manager.switchSession('claude-session');
			expect(manager.getActiveSession()?.providerType).toBe('claude');

			manager.switchSession('opencode-session');
			expect(manager.getActiveSession()?.providerType).toBe('opencode');
		});
	});
});
