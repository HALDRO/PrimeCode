/**
 * @file SessionContext Tests
 * @description Tests for SessionContext - session state management, provider type persistence,
 * snapshot/restore functionality, and conversation management.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type SessionCallbacks,
	SessionContext,
	type SessionSnapshot,
} from '../../services/SessionContext';

// Mock vscode ExtensionContext
const createMockContext = () => ({
	globalState: {
		get: vi.fn(),
		update: vi.fn().mockResolvedValue(undefined),
	},
	workspaceState: {
		get: vi.fn(),
		update: vi.fn().mockResolvedValue(undefined),
	},
	extensionPath: '/mock/extension/path',
	storagePath: '/mock/storage/path',
	globalStoragePath: '/mock/global/storage/path',
	subscriptions: [],
});

// Mock callbacks
const createMockCallbacks = (): SessionCallbacks => ({
	onData: vi.fn(),
	onClose: vi.fn(),
	onError: vi.fn(),
	onCommitCreated: vi.fn(),
	onStateChanged: vi.fn(),
});

describe('SessionContext', () => {
	let context: ReturnType<typeof createMockContext>;
	let callbacks: SessionCallbacks;

	beforeEach(() => {
		context = createMockContext();
		callbacks = createMockCallbacks();
		vi.clearAllMocks();
	});

	describe('Provider Type Management', () => {
		it('should initialize with undefined providerType', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);
			expect(session.providerType).toBeUndefined();
		});

		it('should set and get providerType correctly', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.setProviderType('opencode');
			expect(session.providerType).toBe('opencode');

			session.setProviderType('claude');
			expect(session.providerType).toBe('claude');

			session.setProviderType(undefined);
			expect(session.providerType).toBeUndefined();
		});

		it('should include providerType in snapshot', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);
			session.setProviderType('opencode');

			const snapshot = session.snapshot();

			expect(snapshot.providerType).toBe('opencode');
		});

		it('should restore providerType from snapshot', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			const snapshot: SessionSnapshot = {
				uiSessionId: 'test-session-1',
				cliSessionId: 'ses_abc123',
				providerType: 'opencode',
				totalCost: 0,
				totalTokensInput: 100,
				totalTokensOutput: 50,
				totalReasoningTokens: 0,
				totalDuration: 1000,
				requestCount: 1,
				isProcessing: false,
				commits: [],
				changedFiles: [],
				conversationFilename: undefined,
				conversationStartTime: undefined,
				lastOpenCodeMessageId: 'msg_123',
			};

			session.restore(snapshot);

			expect(session.providerType).toBe('opencode');
			expect(session.cliSessionId).toBe('ses_abc123');
			expect(session.lastOpenCodeMessageId).toBe('msg_123');
		});

		it('should handle missing providerType in old snapshots (backwards compatibility)', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			// Simulate old snapshot without providerType - use unknown first for type safety
			const oldSnapshot = {
				uiSessionId: 'test-session-1',
				cliSessionId: 'ses_abc123',
				providerType: undefined, // Explicitly set to undefined to simulate old snapshot
				totalCost: 0,
				totalTokensInput: 0,
				totalTokensOutput: 0,
				totalReasoningTokens: 0,
				totalDuration: 0,
				requestCount: 0,
				isProcessing: false,
				commits: [],
				changedFiles: [],
				conversationFilename: undefined,
				conversationStartTime: undefined,
				lastOpenCodeMessageId: undefined,
			} as SessionSnapshot;

			session.restore(oldSnapshot);

			// Should be undefined, not crash
			expect(session.providerType).toBeUndefined();
		});
	});

	describe('Snapshot and Restore', () => {
		it('should create complete snapshot with all fields', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.setProviderType('claude');
			session.setCLISessionId('cli-session-123');

			const snapshot = session.snapshot();

			expect(snapshot).toMatchObject({
				uiSessionId: 'test-session-1',
				cliSessionId: 'cli-session-123',
				providerType: 'claude',
				totalCost: 0,
				totalTokensInput: 0,
				totalTokensOutput: 0,
				totalReasoningTokens: 0,
				totalDuration: 0,
				requestCount: 0,
				isProcessing: false,
				commits: [],
				changedFiles: [],
			});
		});

		it('should restore all fields from snapshot', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			const snapshot: SessionSnapshot = {
				uiSessionId: 'test-session-1',
				cliSessionId: 'ses_xyz789',
				providerType: 'claude',
				totalCost: 1.5,
				totalTokensInput: 1000,
				totalTokensOutput: 500,
				totalReasoningTokens: 100,
				totalDuration: 5000,
				requestCount: 3,
				isProcessing: false,
				commits: [{ id: 'commit-1', sha: 'abc123', message: 'test', timestamp: '2024-01-01' }],
				changedFiles: [],
				conversationFilename: 'test-conversation.json',
				conversationStartTime: '2024-01-01T00:00:00Z',
				lastOpenCodeMessageId: 'msg_456',
			};

			session.restore(snapshot);

			expect(session.cliSessionId).toBe('ses_xyz789');
			expect(session.providerType).toBe('claude');
			expect(session.totalCost).toBe(1.5);
			expect(session.totalTokensInput).toBe(1000);
			expect(session.totalTokensOutput).toBe(500);
			expect(session.totalReasoningTokens).toBe(100);
			expect(session.totalDuration).toBe(5000);
			expect(session.requestCount).toBe(3);
			expect(session.commits).toHaveLength(1);
			expect(session.lastOpenCodeMessageId).toBe('msg_456');
		});
	});

	describe('CLI Session ID Management', () => {
		it('should set and get cliSessionId', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			expect(session.cliSessionId).toBeUndefined();

			session.setCLISessionId('ses_abc123');
			expect(session.cliSessionId).toBe('ses_abc123');

			session.setCliSessionId('ses_xyz789'); // alias method
			expect(session.cliSessionId).toBe('ses_xyz789');
		});
	});

	describe('Conversation Messages', () => {
		it('should add conversation messages', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.addConversationMessage({
				type: 'user',
				content: 'Hello',
			});

			expect(session.conversationMessages).toHaveLength(1);
			expect(session.conversationMessages[0].type).toBe('user');
			expect((session.conversationMessages[0] as any).content).toBe('Hello');
		});

		it('should merge streaming assistant messages with same partId', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			// First chunk
			session.addConversationMessage({
				type: 'assistant',
				content: 'Hello',
				partId: 'part-1',
			});

			expect(session.conversationMessages).toHaveLength(1);

			// Second chunk with same partId - should merge
			session.addConversationMessage({
				type: 'assistant',
				content: ' World',
				partId: 'part-1',
				isDelta: true,
			} as any);

			expect(session.conversationMessages).toHaveLength(1);
			expect((session.conversationMessages[0] as any).content).toBe('Hello World');
		});

		it('should NOT merge messages with different partId', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.addConversationMessage({
				type: 'assistant',
				content: 'First message',
				partId: 'part-1',
			});

			session.addConversationMessage({
				type: 'assistant',
				content: 'Second message',
				partId: 'part-2',
			});

			expect(session.conversationMessages).toHaveLength(2);
		});

		it('should deduplicate tool_use by toolUseId', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.addConversationMessage({
				type: 'tool_use',
				toolUseId: 'tool-1',
				toolName: 'read_file',
			} as any);

			// Same toolUseId - should update, not add
			session.addConversationMessage({
				type: 'tool_use',
				toolUseId: 'tool-1',
				toolName: 'read_file',
				status: 'completed',
			} as any);

			expect(session.conversationMessages).toHaveLength(1);
			expect((session.conversationMessages[0] as any).status).toBe('completed');
		});

		it('should clear conversation', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.addConversationMessage({ type: 'user', content: 'Hello' });
			session.addConversationMessage({ type: 'assistant', content: 'Hi', partId: 'p1' });

			expect(session.conversationMessages).toHaveLength(2);

			session.clearConversation();

			expect(session.conversationMessages).toHaveLength(0);
		});

		it('should remove specific message by ID', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.addConversationMessage({ type: 'user', content: 'Hello', id: 'msg-1' });
			session.addConversationMessage({ type: 'error', content: 'Error occurred', id: 'msg-2' });

			expect(session.conversationMessages).toHaveLength(2);

			const removed = session.removeConversationMessage('msg-2');

			expect(removed).toBe(true);
			expect(session.conversationMessages).toHaveLength(1);
			expect(session.conversationMessages[0].id).toBe('msg-1');
		});

		it('should clear error messages', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.addConversationMessage({ type: 'user', content: 'Hello', id: 'msg-1' });
			session.addConversationMessage({ type: 'error', content: 'Error 1', id: 'msg-2' });
			session.addConversationMessage({
				type: 'assistant',
				content: 'Response',
				id: 'msg-3',
				partId: 'p1',
			});
			session.addConversationMessage({ type: 'interrupted', content: 'Stopped', id: 'msg-4' });

			const clearedIds = session.clearErrorMessages();

			expect(clearedIds).toContain('msg-2');
			expect(clearedIds).toContain('msg-4');
			expect(session.conversationMessages).toHaveLength(2);
			expect(session.conversationMessages.map(m => m.type)).toEqual(['user', 'assistant']);
		});
	});

	describe('Processing State', () => {
		it('should track processing state', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			expect(session.isProcessing).toBe(false);

			session.setProcessing(true);
			expect(session.isProcessing).toBe(true);

			session.setProcessing(false);
			expect(session.isProcessing).toBe(false);
		});

		it('should track auto-retrying state', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			expect(session.isAutoRetrying).toBe(false);

			session.setAutoRetrying(true);
			expect(session.isAutoRetrying).toBe(true);
		});
	});

	describe('Stats Tracking', () => {
		it('should get stats snapshot', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			const stats = session.getStats();

			expect(stats).toMatchObject({
				totalCost: 0,
				totalTokensInput: 0,
				totalTokensOutput: 0,
				totalReasoningTokens: 0,
				totalDuration: 0,
				requestCount: 0,
			});
		});

		it('should update stats', () => {
			const session = new SessionContext('test-session-1', callbacks, context as any);

			session.updateStats(0.5, 1000);
			session.updateStats(0.3, 500);

			const stats = session.getStats();

			expect(stats.totalCost).toBe(0.8);
			expect(stats.totalDuration).toBe(1500);
			expect(stats.requestCount).toBe(2);
		});
	});
});
