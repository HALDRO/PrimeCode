/**
 * @file Mock VS Code API for browser development
 * @description Provides a professional, comprehensive scenario-based mock implementation.
 *              Demonstrates all UI capabilities: complex markdown, diffs, MCP, bash, and stats.
 *              Uses unified session_event / session_lifecycle protocol for consistency with production.
 */

import type { VSCodeApi } from '../../types';

declare global {
	interface Window {
		vscode?: VSCodeApi;
		acquireVsCodeApi?: () => VSCodeApi;
	}
}

/**
 * Mock message type - all messages use unified session_event protocol
 */
interface MockMessage {
	type: 'session_event' | 'session_lifecycle';
	delay?: number;
	// session_event fields
	targetId?: string;
	eventType?: string;
	payload?: unknown;
	timestamp?: number;
	// session_lifecycle fields
	action?: 'created' | 'closed' | 'switched' | 'cleared';
	sessionId?: string;
	data?: Record<string, unknown>;
}

let mockState: Record<string, unknown> = {};
let activeTimers: NodeJS.Timeout[] = [];
const mockActiveSessionId = 'premium-dev-session';
let isScenarioRunning = false;
let isLaunched = false;

function createId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// =============================================================================
// Unified Session Event Helpers
// =============================================================================

/** Dispatch a session_event message */
function dispatchSessionEvent(
	targetId: string,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	window.postMessage(
		{
			type: 'session_event',
			targetId,
			eventType,
			payload: { eventType, ...payload },
			timestamp: Date.now(),
		},
		'*',
	);
}

/** Dispatch a session_lifecycle message */
function dispatchSessionLifecycle(
	action: 'created' | 'closed' | 'switched' | 'cleared',
	sessionId: string,
	data?: Record<string, unknown>,
): void {
	window.postMessage(
		{
			type: 'session_lifecycle',
			action,
			sessionId,
			data,
		},
		'*',
	);
}

/** Dispatch a message event to a session */
function dispatchMessage(targetId: string, message: Record<string, unknown>): void {
	dispatchSessionEvent(targetId, 'message', { message });
}

/** Dispatch a status event to a session */
function dispatchStatus(
	targetId: string,
	status: 'idle' | 'busy' | 'error' | 'retrying',
	statusText?: string,
): void {
	dispatchSessionEvent(targetId, 'status', { status, statusText });
}

/** Dispatch a restore event to a session */
function dispatchRestore(targetId: string, action: string, data?: Record<string, unknown>): void {
	dispatchSessionEvent(targetId, 'restore', { action, ...data });
}

/** Dispatch a global (non-session) message to webview */
function dispatchGlobalMessage(type: string, data?: unknown): void {
	window.postMessage({ type, data }, '*');
}

/** Clear all active mock timers */
function clearAllMockTimers(): void {
	for (const timer of activeTimers) {
		clearTimeout(timer);
	}
	activeTimers = [];
}

/** Run a sequence of mock messages */
async function runScenario(messages: MockMessage[], clearSession = false): Promise<void> {
	// If a scenario is already running, we stop it to start a new one
	clearAllMockTimers();
	isScenarioRunning = true;

	if (clearSession) {
		dispatchSessionLifecycle('cleared', mockActiveSessionId);
		await new Promise(r => setTimeout(r, 100));
	}

	// Set processing state so the UI shows the Stop button
	dispatchStatus(mockActiveSessionId, 'busy', 'Processing...');
	await new Promise(r => setTimeout(r, 100));

	for (const msg of messages) {
		// If isScenarioRunning becomes false (via stopRequest), we abort
		if (!isScenarioRunning) {
			break;
		}

		await new Promise(resolve => {
			const timer = setTimeout(() => {
				if (msg.type === 'session_event' && msg.targetId && msg.eventType && msg.payload) {
					window.postMessage(
						{
							type: 'session_event',
							targetId: msg.targetId,
							eventType: msg.eventType,
							payload: msg.payload,
							timestamp: msg.timestamp || Date.now(),
						},
						'*',
					);
				} else if (msg.type === 'session_lifecycle' && msg.action && msg.sessionId) {
					window.postMessage(
						{
							type: 'session_lifecycle',
							action: msg.action,
							sessionId: msg.sessionId,
							data: msg.data,
						},
						'*',
					);
				}
				resolve(null);
			}, msg.delay || 600);
			activeTimers.push(timer);
		});
	}

	dispatchStatus(mockActiveSessionId, 'idle', 'Ready');
	isScenarioRunning = false;
}

// =============================================================================
// SCENARIO 1: The Master Architect (Complete Feature Showcase)
// =============================================================================

const SCENARIO_1_RESEARCHER: MockMessage[] = (() => {
	const editAppId = createId('t');
	const googleSearchId = createId('t');
	const thinkingId1 = createId('thinking');

	const assistantContent = [
		'### 🚀 System Modernization Complete',
		'',
		'I have completed the requested tasks.',
		'',
		'#### 🛠 Accomplishments:',
		'1. **Enhanced Architecture**: Integrated `logger.ts` with structured logging.',
		'2. **Quality Assurance**: Achieved **100% test coverage**.',
		'3. **Performance**: Reduced bundle size by ~15%.',
		'',
		'#### Code Example',
		'',
		'```typescript',
		'import { logger } from "./utils/logger";',
		'',
		'function greet(name: string): string {',
		'  logger.info("Greeting: " + name);',
		'  return "Hello, " + name + "!";',
		'}',
		'```',
		'',
		'#### Performance Metrics',
		'',
		'| Metric | Before | After |',
		'|--------|--------|-------|',
		'| Bundle | 245 KB | 208 KB |',
		'| Load | 1.2s | 0.8s |',
		'',
		'#### Key Features',
		'',
		'- **Logging**: Structured JSON logs with levels',
		'- **Error Handling**: Global error boundary',
		'- **State Management**: Zustand store integration',
		'',
		'> **Note**: All changes are backward compatible.',
	].join('\n');

	return [
		// User message
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: 'm1',
					type: 'user',
					content:
						'# Task: System Modernization\nI need to analyze the project architecture. Please:\n1. Check `@package.json` for vulnerabilities.\n2. Update `@src/App.tsx` to handle global state.\n3. Run full test suite.',
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 100,
		},
		// Checkpoint
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'restore',
			payload: {
				eventType: 'restore',
				action: 'add_commit',
				commit: {
					id: 'checkpoint-1',
					sha: 'abc123def456',
					message: 'Checkpoint before System Modernization',
					timestamp: new Date().toISOString(),
					associatedMessageId: 'm1',
					sessionId: mockActiveSessionId,
					cliSessionId: 'cli-session-123',
					isOpenCodeCheckpoint: true,
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// Thinking
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: thinkingId1,
					type: 'thinking',
					content:
						'Scanning workspace and building dependency graph...\n\nAnalyzing project structure to understand the codebase architecture. Looking for:\n- Entry points and main components\n- Utility functions and shared modules\n- Test coverage and configuration\n- Build and deployment setup',
					partId: thinkingId1,
					durationMs: 2340,
					reasoningTokens: 156,
					isStreaming: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 800,
		},
		// TodoWrite tool_use
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('tool'),
					type: 'tool_use',
					toolName: 'TodoWrite',
					toolUseId: 'todo-demo-create',
					rawInput: {
						merge: false,
						todos: [
							{ content: 'Analysis', status: 'in_progress' },
							{ content: 'Refactor', status: 'pending' },
							{ content: 'Testing', status: 'pending' },
						],
					},
					isRunning: true,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 400,
		},
		// TodoWrite tool_result
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('result'),
					type: 'tool_result',
					toolName: 'TodoWrite',
					toolUseId: 'todo-demo-create',
					content: 'Created todos',
					isError: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// LS tool_use
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('tool'),
					type: 'tool_use',
					toolName: 'LS',
					toolUseId: 't1',
					filePath: 'src/',
					rawInput: { path: 'src/' },
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 400,
		},
		// LS tool_result
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('result'),
					type: 'tool_result',
					toolName: 'LS',
					toolUseId: 't1',
					content: 'components/\nutils/\nApp.tsx\nconfig.json\nstyles.css',
					isError: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 300,
		},
		// File changed event
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'file',
			payload: {
				eventType: 'file',
				action: 'changed',
				filePath: 'src/App.tsx',
				fileName: 'App.tsx',
				linesAdded: 3,
				linesRemoved: 2,
				toolUseId: editAppId,
			},
			timestamp: Date.now(),
			delay: 100,
		},
		// Edit tool_use
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('tool'),
					type: 'tool_use',
					toolName: 'Edit',
					toolUseId: editAppId,
					filePath: 'src/App.tsx',
					rawInput: {
						file_path: 'src/App.tsx',
						old_string: 'const [count, setCount] = useState(0);\nreturn <button>{count}</button>;',
						new_string:
							'const [count, setCount] = useState(0);\nconst increment = () => setCount(c => c + 1);\nreturn <button onClick={increment}>{count}</button>;',
					},
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 800,
		},
		// Edit access_request
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('access'),
					type: 'access_request',
					requestId: 'acc-edit-1',
					toolUseId: editAppId,
					tool: 'Edit',
					input: {
						file_path: 'src/App.tsx',
						old_string: 'const [count, setCount] = useState(0);\nreturn <button>{count}</button>;',
						new_string:
							'const [count, setCount] = useState(0);\nconst increment = () => setCount(c => c + 1);\nreturn <button onClick={increment}>{count}</button>;',
					},
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// Edit tool_result
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('result'),
					type: 'tool_result',
					toolName: 'Edit',
					toolUseId: editAppId,
					content: 'Updated App.tsx',
					isError: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 1000,
		},
		// MCP tool_use
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('tool'),
					type: 'tool_use',
					toolName: 'mcp__google__search',
					toolUseId: googleSearchId,
					rawInput: { query: 'React 19' },
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 800,
		},
		// MCP access_request
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('access'),
					type: 'access_request',
					requestId: 'acc-mcp-1',
					toolUseId: googleSearchId,
					tool: 'mcp__google__search',
					input: { query: 'React 19' },
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// MCP tool_result
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('result'),
					type: 'tool_result',
					toolName: 'mcp__google__search',
					toolUseId: googleSearchId,
					content: '{"status": "ok", "results": [{"title": "React 19 RC"}]}',
					isError: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 1000,
		},
		// Bash tool_use
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('tool'),
					type: 'tool_use',
					toolName: 'Bash',
					toolUseId: 't5',
					rawInput: { command: 'npm test' },
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 400,
		},
		// Bash access_request
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('access'),
					type: 'access_request',
					requestId: 'acc-1',
					toolUseId: 't5',
					tool: 'Bash',
					input: { command: 'npm test' },
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// Bash tool_result
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('result'),
					type: 'tool_result',
					toolName: 'Bash',
					toolUseId: 't5',
					content: 'PASS src/App.test.tsx\nPASS src/utils/logger.test.ts',
					isError: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 1000,
		},
		// TodoWrite update tool_use
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('tool'),
					type: 'tool_use',
					toolName: 'TodoWrite',
					toolUseId: 'todo-demo-complete',
					rawInput: {
						merge: true,
						todos: [
							{ content: 'Analysis', status: 'completed' },
							{ content: 'Refactor', status: 'completed' },
							{ content: 'Testing', status: 'completed' },
						],
					},
					isRunning: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 400,
		},
		// TodoWrite update tool_result
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('result'),
					type: 'tool_result',
					toolName: 'TodoWrite',
					toolUseId: 'todo-demo-complete',
					content: 'All todos completed',
					isError: false,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// Assistant response
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'message',
			payload: {
				eventType: 'message',
				message: {
					id: createId('assistant'),
					type: 'assistant',
					content: assistantContent,
					timestamp: new Date().toISOString(),
				},
			},
			timestamp: Date.now(),
			delay: 1000,
		},
		// Token stats
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'stats',
			payload: {
				eventType: 'stats',
				tokenStats: {
					totalTokensInput: 128000,
					totalTokensOutput: 12000,
					currentInputTokens: 128000,
					currentOutputTokens: 12000,
					cacheCreationTokens: 40000,
					cacheReadTokens: 78000,
					reasoningTokens: 156,
					totalReasoningTokens: 156,
				},
			},
			timestamp: Date.now(),
			delay: 200,
		},
		// Total stats
		{
			type: 'session_event',
			targetId: mockActiveSessionId,
			eventType: 'stats',
			payload: {
				eventType: 'stats',
				totalStats: {
					totalCost: 0.158,
					totalTokensInput: 128000,
					totalTokensOutput: 12000,
					totalReasoningTokens: 156,
					requestCount: 24,
					totalDuration: 45000,
				},
			},
			timestamp: Date.now(),
			delay: 100,
		},
	];
})();

// =============================================================================
// API Mock Implementation
// =============================================================================

const mockVSCodeApi: VSCodeApi = {
	postMessage: (message: unknown) => {
		const msg = message as {
			type: string;
			text?: string;
			data?: { text?: string; message?: string };
		};
		console.log('[Mock VS Code] Received:', msg.type, msg.data);

		if (msg.type === 'sendMessage') {
			// Extract user message content - data is spread directly into msg
			const userContent = msg.text || msg.data?.text || msg.data?.message || 'Follow-up message';
			const userMessageId = createId('user');

			// Demo: /<command> [args...] -> show compaction-style notice + simple assistant reply
			// This lets you quickly verify slash-command UX in the browser mock without wiring real SDK.
			const trimmed = userContent.trim();
			if (trimmed.startsWith('/')) {
				const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
				const commandName = match?.[1] || '';
				const args = (match?.[2] || '').trim();

				// Keep specialized demos below (todo demo, etc.) by only handling slash commands first.
				// The /compact command is treated specially to match real app behavior.
				if (commandName.length > 0) {
					const isCompact = commandName === 'compact';
					const noticeText = isCompact
						? args
							? `Summarizing context: ${args}`
							: 'Summarizing context'
						: args
							? `Running /${commandName}: ${args}`
							: `Running /${commandName}`;

					const commandScenario: MockMessage[] = [
						{
							type: 'session_event',
							targetId: mockActiveSessionId,
							eventType: 'message',
							payload: {
								eventType: 'message',
								message: {
									id: userMessageId,
									type: 'user',
									content: userContent,
									timestamp: new Date().toISOString(),
								},
							},
							timestamp: Date.now(),
							delay: 100,
						},
						{
							type: 'session_event',
							targetId: mockActiveSessionId,
							eventType: 'message',
							payload: {
								eventType: 'message',
								message: {
									id: createId('notice'),
									type: 'system_notice',
									content: noticeText,
									timestamp: new Date().toISOString(),
								},
							},
							timestamp: Date.now(),
							delay: 450,
						},
						{
							type: 'session_event',
							targetId: mockActiveSessionId,
							eventType: 'message',
							payload: {
								eventType: 'message',
								message: {
									id: createId('assistant'),
									type: 'assistant',
									content: isCompact
										? 'Context summary complete. Continue with your next request — the conversation context is now condensed for a larger effective window.'
										: `Executed /${commandName}${args ? ` ${args}` : ''}.`,
									timestamp: new Date().toISOString(),
								},
							},
							timestamp: Date.now(),
							delay: 600,
						},
					];

					runScenario(commandScenario, false);
					return;
				}
			}

			// Demo: TodoWrite lifecycle (create -> update -> complete)
			if (
				userContent.toLowerCase().includes('todo demo') ||
				userContent.toLowerCase().includes('tudу демо') ||
				userContent.toLowerCase().includes('туду демо') ||
				userContent.toLowerCase().includes('todo туду') ||
				userContent.toLowerCase().includes('туду todo')
			) {
				const todoCreateUseId = createId('todo-create');
				const todoUpdateUseId = createId('todo-update');
				const todoCompleteUseId = createId('todo-complete');
				const thinkingPartId = createId('thinking');

				const todoScenario: MockMessage[] = [
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: userMessageId,
								type: 'user',
								content: userContent,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: thinkingPartId,
								type: 'thinking',
								content:
									'Planning tasks and creating initial TODO list...\n\nI will create a short set of steps, then update their statuses as work progresses.',
								partId: thinkingPartId,
								durationMs: 900,
								reasoningTokens: 42,
								isStreaming: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 500,
					},
					// Create (running) -> should auto-expand
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: todoCreateUseId,
								type: 'tool_use',
								toolName: 'TodoWrite',
								toolUseId: todoCreateUseId,
								rawInput: {
									merge: false,
									todos: [
										{ id: 'todo-1', content: 'Analysis Logger Refactor', status: 'in_progress' },
										{ id: 'todo-2', content: 'Finalize', status: 'pending' },
									],
								},
								isRunning: true,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 700,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: `${todoCreateUseId}:result`,
								type: 'tool_result',
								toolName: 'TodoWrite',
								toolUseId: todoCreateUseId,
								content: 'Created 2 todos',
								isError: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 200,
					},
					// Update (not running) -> should stay compact by default
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: todoUpdateUseId,
								type: 'tool_use',
								toolName: 'TodoWrite',
								toolUseId: todoUpdateUseId,
								rawInput: {
									merge: true,
									todos: [
										{ id: 'todo-1', content: 'Analysis Logger Refactor', status: 'completed' },
										{ id: 'todo-2', content: 'Finalize', status: 'in_progress' },
									],
								},
								isRunning: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 900,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: `${todoUpdateUseId}:result`,
								type: 'tool_result',
								toolName: 'TodoWrite',
								toolUseId: todoUpdateUseId,
								content: 'Updated todo statuses',
								isError: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 200,
					},
					// Complete (not running) -> compact header shows final progress
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: todoCompleteUseId,
								type: 'tool_use',
								toolName: 'TodoWrite',
								toolUseId: todoCompleteUseId,
								rawInput: {
									merge: true,
									todos: [
										{ id: 'todo-1', content: 'Analysis Logger Refactor', status: 'completed' },
										{ id: 'todo-2', content: 'Finalize', status: 'completed' },
									],
								},
								isRunning: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 900,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: `${todoCompleteUseId}:result`,
								type: 'tool_result',
								toolName: 'TodoWrite',
								toolUseId: todoCompleteUseId,
								content: 'All todos completed',
								isError: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 200,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('assistant'),
								type: 'assistant',
								content:
									'✅ Todo demo complete. Notice: initial create auto-expands; subsequent updates stay compact unless you manually expand.',
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 500,
					},
				];

				runScenario(todoScenario, false);
				return;
			}

			// Demo: Handle specific commands for testing
			if (userContent.includes('new chat')) {
				const newSessionId = createId('session');
				dispatchSessionLifecycle('created', newSessionId);

				// Start a mini-scenario in the new chat
				setTimeout(() => {
					runScenario(
						[
							{
								type: 'session_event',
								targetId: newSessionId,
								eventType: 'message',
								payload: {
									eventType: 'message',
									message: {
										id: createId('assistant'),
										type: 'assistant',
										content: 'Hello! This is a new chat session. How can I help you?',
										timestamp: new Date().toISOString(),
									},
								},
								timestamp: Date.now(),
								delay: 500,
							},
						],
						false,
					);
				}, 500);
				return;
			}

			if (userContent.includes('change file')) {
				const editId = createId('edit');
				const thinkingId = createId('thinking');
				const dynamicScenario: MockMessage[] = [
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: userMessageId,
								type: 'user',
								content: userContent,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: thinkingId,
								type: 'thinking',
								content:
									'Modifying file to demonstrate changes...\n\nPreparing to update the demo file with new content to showcase the file change tracking feature.',
								partId: thinkingId,
								durationMs: 1100,
								reasoningTokens: 48,
								isStreaming: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 600,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: editId,
								type: 'tool_use',
								toolName: 'Edit',
								toolUseId: editId,
								filePath: 'src/demo.ts',
								rawInput: {
									file_path: 'src/demo.ts',
									old_string: '',
									new_string: '// Demo change',
								},
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 800,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: `${editId}:result`,
								type: 'tool_result',
								toolName: 'Edit',
								toolUseId: editId,
								content: 'Applied changes',
								isError: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 200,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'file',
						payload: {
							eventType: 'file',
							action: 'changed',
							filePath: 'src/demo.ts',
							fileName: 'demo.ts',
							linesAdded: 5,
							linesRemoved: 1,
							toolUseId: editId,
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('assistant'),
								type: 'assistant',
								content:
									'I have modified `src/demo.ts`. You should see the changes in the Changed Files panel.',
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 500,
					},
				];
				runScenario(dynamicScenario, false);
				return;
			}

			// Demo: Generate error message for testing ErrorMessage component
			if (
				userContent.toLowerCase().includes('error') ||
				userContent.toLowerCase().includes('ошибк')
			) {
				const thinkingId = createId('thinking');
				const toolId = createId('t');
				const errorScenario: MockMessage[] = [
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: userMessageId,
								type: 'user',
								content: userContent,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: thinkingId,
								type: 'thinking',
								content: 'Processing request...\n\nAttempting to execute the requested operation.',
								partId: thinkingId,
								durationMs: 800,
								reasoningTokens: 24,
								isStreaming: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 500,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: toolId,
								type: 'tool_use',
								toolName: 'Bash',
								toolUseId: toolId,
								rawInput: { command: 'npm run build' },
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 400,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('error'),
								type: 'error',
								content: `API Error: Rate limit exceeded\n\nYou have exceeded the maximum number of requests per minute.\nPlease wait 30 seconds before retrying.\n\nRequest ID: req_abc123xyz\nTimestamp: ${new Date().toISOString()}`,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 800,
					},
				];
				runScenario(errorScenario, false);
				return;
			}

			// Demo: Generate simple error
			if (userContent.toLowerCase().includes('simple error')) {
				const simpleErrorScenario: MockMessage[] = [
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: userMessageId,
								type: 'user',
								content: userContent,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('error'),
								type: 'error',
								content: 'Connection timeout: Unable to reach the API server.',
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 400,
					},
				];
				runScenario(simpleErrorScenario, false);
				return;
			}

			// Demo: Subagent Scenario
			if (
				userContent.toLowerCase().includes('subagent') ||
				userContent.toLowerCase().includes('sub-agent') ||
				userContent.toLowerCase().includes('саб агент') ||
				userContent.toLowerCase().includes('саб-агент') ||
				userContent.toLowerCase().includes('сабагент')
			) {
				const subtaskId = createId('subtask');
				const contextId = createId('context');
				const toolLsId = createId('t');
				const toolLsResultId = `${toolLsId}:result`;
				const toolReadId = createId('t');
				const toolReadResultId = `${toolReadId}:result`;
				const thinkingId1 = createId('thinking');
				const thinkingId2 = createId('thinking');
				const thinkingId3 = createId('thinking');

				const subagentScenario: MockMessage[] = [
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: userMessageId,
								type: 'user',
								content: userContent,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('assistant'),
								type: 'assistant',
								content:
									'I will delegate this complex refactoring task to our **Frontend Architect** sub-agent for a detailed analysis.',
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 500,
					},
					// 1. Create context session for subtask (lazy creation in store)
					{
						type: 'session_lifecycle',
						action: 'created',
						sessionId: contextId,
						data: { isContext: true, parentSessionId: mockActiveSessionId },
						delay: 100,
					},
					// 2. Subtask Start (linked to context)
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: subtaskId,
								type: 'subtask',
								agent: 'frontend-architect',
								prompt: 'Analyze src/components/UserProfile.tsx for refactoring opportunities.',
								description: 'Analyzing component structure...',
								status: 'running',
								contextId: contextId,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 800,
					},
					// 3. Context session: Thinking 1
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: thinkingId1,
								type: 'thinking',
								content:
									'I need to explore the file structure first to understand dependencies and context.',
								partId: thinkingId1,
								durationMs: 800,
								isStreaming: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 400,
					},
					// 4. Context session: Tool LS
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: toolLsId,
								type: 'tool_use',
								toolName: 'LS',
								toolUseId: toolLsId,
								filePath: 'src/components',
								rawInput: { path: 'src/components' },
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 600,
					},
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: toolLsResultId,
								type: 'tool_result',
								toolName: 'LS',
								toolUseId: toolLsId,
								content: 'UserProfile.tsx\nHeader.tsx\nFooter.tsx\nButton.tsx',
								isError: false,
								estimatedTokens: 45,
								durationMs: 800,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 800,
					},
					// 5. Context session: Thinking 2
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: thinkingId2,
								type: 'thinking',
								content:
									'Okay, I see UserProfile.tsx. Now I need to examine its content to identify monolithic patterns.',
								partId: thinkingId2,
								durationMs: 1200,
								reasoningTokens: 120,
								isStreaming: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 600,
					},
					// 6. Context session: Tool Read
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: toolReadId,
								type: 'tool_use',
								toolName: 'Read',
								toolUseId: toolReadId,
								filePath: 'src/components/UserProfile.tsx',
								rawInput: { path: 'src/components/UserProfile.tsx' },
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 800,
					},
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: toolReadResultId,
								type: 'tool_result',
								toolName: 'Read',
								toolUseId: toolReadId,
								content:
									'export const UserProfile = () => {\n  // ... 500 lines of code ...\n  return (\n    <div>\n      <Avatar />\n      <UserInfo />\n      <Settings />\n    </div>\n  );\n};',
								isError: false,
								estimatedTokens: 850,
								durationMs: 1000,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 1000,
					},
					// 7. Context session: Thinking 3 (Final Analysis)
					{
						type: 'session_event',
						targetId: contextId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: thinkingId3,
								type: 'thinking',
								content:
									'The component is indeed too large (500+ lines). It mixes presentation and logic. I recommend splitting it into `Avatar`, `UserInfo`, and `Settings` components.',
								partId: thinkingId3,
								durationMs: 1500,
								isStreaming: false,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 800,
					},
					// 8. Subtask Completion (in parent session)
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: subtaskId,
								type: 'subtask',
								agent: 'frontend-architect',
								prompt: 'Analyze src/components/UserProfile.tsx for refactoring opportunities.',
								description: 'Analysis complete: 3 sub-components identified',
								status: 'completed',
								result:
									'Refactoring plan: Split UserProfile.tsx into Avatar, UserInfo, and Settings.',
								contextId: contextId,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 1000,
					},
					// 9. Main Assistant Final Response
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('assistant'),
								type: 'assistant',
								content:
									'The **Frontend Architect** has analyzed `UserProfile.tsx`. It recommends splitting the file into three smaller components:\n\n1.  `Avatar`\n2.  `UserInfo`\n3.  `Settings`\n\nShall I proceed with creating these files?',
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 600,
					},
				];
				runScenario(subagentScenario, false);
				return;
			}

			// Create dynamic scenario with user's actual message
			const dynamicScenario: MockMessage[] = [
				{
					type: 'session_event',
					targetId: mockActiveSessionId,
					eventType: 'message',
					payload: {
						eventType: 'message',
						message: {
							id: userMessageId,
							type: 'user',
							content: userContent,
							timestamp: new Date().toISOString(),
						},
					},
					timestamp: Date.now(),
					delay: 100,
				},
				{
					type: 'session_event',
					targetId: mockActiveSessionId,
					eventType: 'restore',
					payload: {
						eventType: 'restore',
						action: 'add_commit',
						commit: {
							id: createId('checkpoint'),
							sha: createId('commit'),
							message: 'Checkpoint before message',
							timestamp: new Date().toISOString(),
							associatedMessageId: userMessageId,
							sessionId: mockActiveSessionId,
							cliSessionId: 'cli-session-mock',
							isOpenCodeCheckpoint: true,
						},
					},
					timestamp: Date.now(),
					delay: 200,
				},
				{
					type: 'session_event',
					targetId: mockActiveSessionId,
					eventType: 'message',
					payload: {
						eventType: 'message',
						message: {
							id: createId('thinking'),
							type: 'thinking',
							content:
								'Processing your request...\n\nAnalyzing the input and determining the best approach to provide a helpful response.',
							partId: createId('thinking'),
							durationMs: 1500,
							reasoningTokens: 52,
							isStreaming: false,
							timestamp: new Date().toISOString(),
						},
					},
					timestamp: Date.now(),
					delay: 600,
				},
				{
					type: 'session_event',
					targetId: mockActiveSessionId,
					eventType: 'message',
					payload: {
						eventType: 'message',
						message: {
							id: createId('assistant'),
							type: 'assistant',
							content: `I've received your message and processed it. Here's my response:\n\n${
								userContent.length > 50
									? 'Based on your detailed request, I have analyzed the requirements and prepared a comprehensive solution.'
									: 'What would you like me to help you with next?'
							}`,
							timestamp: new Date().toISOString(),
						},
					},
					timestamp: Date.now(),
					delay: 800,
				},
				{
					type: 'session_event',
					targetId: mockActiveSessionId,
					eventType: 'stats',
					payload: {
						eventType: 'stats',
						tokenStats: {
							totalTokensInput: 500,
							totalTokensOutput: 150,
							currentInputTokens: 500,
							currentOutputTokens: 150,
							cacheCreationTokens: 0,
							cacheReadTokens: 0,
							reasoningTokens: 52,
							totalReasoningTokens: 52,
						},
					},
					timestamp: Date.now(),
					delay: 100,
				},
			];

			runScenario(dynamicScenario, false);
		} else if (msg.type === 'stopRequest') {
			isScenarioRunning = false;
			clearAllMockTimers();
			dispatchStatus(mockActiveSessionId, 'idle', 'Stopped');
			// Send interrupted message so user can resume
			dispatchMessage(mockActiveSessionId, {
				type: 'interrupted',
				content: 'Processing was stopped by user',
				reason: 'user_stopped',
				id: createId('interrupted'),
				timestamp: new Date().toISOString(),
			});
			console.log('[Mock VS Code] STOPPED - sent interrupted message');
		} else if (msg.type === 'resumeAfterError') {
			// Handle resume after error - simulate continuation
			const { sessionId } = msg as { sessionId?: string };
			console.log('[Mock VS Code] Resume after error for session:', sessionId);

			const resumeUserId = createId('user');
			const resumeThinkingId = createId('thinking');
			const resumeScenario: MockMessage[] = [
				{
					type: 'session_event',
					targetId: sessionId || mockActiveSessionId,
					eventType: 'message',
					payload: {
						eventType: 'message',
						message: {
							id: resumeUserId,
							type: 'user',
							content: 'Continue from where you left off.',
							timestamp: new Date().toISOString(),
						},
					},
					timestamp: Date.now(),
					delay: 100,
				},
				{
					type: 'session_event',
					targetId: sessionId || mockActiveSessionId,
					eventType: 'message',
					payload: {
						eventType: 'message',
						message: {
							id: resumeThinkingId,
							type: 'thinking',
							content:
								'Resuming from previous state...\n\nAnalyzing context and continuing execution.',
							partId: resumeThinkingId,
							durationMs: 1200,
							reasoningTokens: 35,
							isStreaming: false,
							timestamp: new Date().toISOString(),
						},
					},
					timestamp: Date.now(),
					delay: 600,
				},
				{
					type: 'session_event',
					targetId: sessionId || mockActiveSessionId,
					eventType: 'message',
					payload: {
						eventType: 'message',
						message: {
							id: createId('assistant'),
							type: 'assistant',
							content:
								'I have resumed execution. The previous error has been handled and I am continuing with the task.\n\nWhat would you like me to do next?',
							timestamp: new Date().toISOString(),
						},
					},
					timestamp: Date.now(),
					delay: 800,
				},
			];
			runScenario(resumeScenario, false);
		} else if (msg.type === 'dismissError') {
			// Handle dismiss error - remove the error message from UI
			const { messageId, sessionId } = msg as { messageId?: string; sessionId?: string };
			console.log('[Mock VS Code] Dismiss error:', messageId, 'session:', sessionId);

			if (messageId) {
				dispatchSessionEvent(sessionId || mockActiveSessionId, 'complete', {
					partId: messageId,
					removed: true,
					messageId,
				});
			}
		} else if (msg.type === 'accessResponse') {
			// Simulate resolving the active access request in the chat
			const { id, approved, alwaysAllow } = msg as {
				id?: string;
				approved?: boolean;
				alwaysAllow?: boolean;
			};
			if (id && approved !== undefined) {
				dispatchSessionEvent(mockActiveSessionId, 'access', {
					action: 'response',
					requestId: id,
					approved,
					alwaysAllow,
				});
			}
		} else if (msg.type === 'createSession') {
			const newSessionId = createId('session');
			console.log('[Mock VS Code] Creating session:', newSessionId);
			// Simulate a slight delay to mimic backend processing
			setTimeout(() => {
				dispatchSessionLifecycle('created', newSessionId);
			}, 100);
		} else if (msg.type === 'switchSession') {
			const { sessionId } = msg as unknown as { sessionId: string };
			console.log('[Mock VS Code] Switched to session:', sessionId);
			dispatchSessionLifecycle('switched', sessionId);
		} else if (msg.type === 'closeSession') {
			const { sessionId } = msg as unknown as { sessionId: string };
			console.log('[Mock VS Code] Closed session:', sessionId);
			dispatchSessionLifecycle('closed', sessionId);
		} else if (msg.type === 'webviewDidLaunch') {
			if (isLaunched) {
				console.log('[Mock VS Code] Already launched, skipping duplicate init');
				return;
			}
			isLaunched = true;

			setTimeout(() => {
				// 1. First create the session in the store
				dispatchSessionLifecycle('created', mockActiveSessionId);

				// 2. Then switch to it with initial state
				dispatchSessionLifecycle('switched', mockActiveSessionId, {
					isProcessing: false,
					totalStats: {
						totalCost: 0,
						totalTokensInput: 0,
						totalTokensOutput: 0,
						totalReasoningTokens: 0,
						requestCount: 0,
						totalDuration: 0,
					},
				});

				// 3. Set ready status
				dispatchStatus(mockActiveSessionId, 'idle', 'Ready');

				// 4. Send session info via session_event
				dispatchSessionEvent(mockActiveSessionId, 'session_info', {
					data: {
						sessionId: mockActiveSessionId,
						tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS', 'TodoWrite'],
						mcpServers: [],
					},
				});

				// 5. Global messages (non-session-scoped)
				dispatchGlobalMessage('openCodeModelSet', { model: 'anthropic/claude-opus-4-5' });
				dispatchGlobalMessage('workspaceInfo', { name: 'primecode' });
				dispatchGlobalMessage('workspaceFiles', [
					{ path: 'src/App.tsx', name: 'App.tsx', fsPath: 'C:\\src\\App.tsx' },
					{ path: 'src/utils/logger.ts', name: 'logger.ts', fsPath: 'C:\\src\\utils\\logger.ts' },
					{ path: 'package.json', name: 'package.json', fsPath: 'C:\\package.json' },
				]);
				runScenario(SCENARIO_1_RESEARCHER, true);
			}, 300);
		} else if (msg.type === 'getSettings') {
			dispatchGlobalMessage('settingsData', {
				provider: 'opencode', // Use opencode to show all provider features
				'primeCode.baseUrl': 'http://localhost:11434',
				'primeCode.apiKey': '',
				'primeCode.enabledModels': [],
				'opencode.agent': '',
				'opencode.enabledModels': ['anthropic/claude-opus-4-5', 'google/gemini-2.0-flash'],
				'providers.disabled': [],
			});
			dispatchGlobalMessage('platformInfo', { platform: 'win32', isWindows: true });
		} else if (msg.type === 'checkDiscoveryStatus') {
			dispatchGlobalMessage('discoveryStatus', {
				rules: {
					hasAgentsMd: true,
					hasClaudeMd: true,
					hasClaudeShim: true,
					ruleFiles: [
						'.agents/rules/base.md',
						'.agents/rules/disabled/legacy.md',
						'.opencode/agent/default.md',
					],
				},
				permissions: {
					claudeConfig: '.claude/settings.json',
					openCodeConfig: 'opencode.json',
				},
				skills: [
					{
						name: 'frontend-design',
						path: '.claude/skills/frontend-design/SKILL.md',
						type: 'claude',
					},
					{
						name: 'mcp-integration',
						path: '.opencode/skills/mcp-integration.md',
						type: 'opencode',
					},
				],
				hooks: [{ name: 'SessionStart.ts', path: '.claude/hooks/SessionStart.ts', type: 'claude' }],
			});
		} else if (msg.type === 'getRules') {
			dispatchGlobalMessage('ruleList', {
				rules: [
					{
						name: 'base.md',
						path: '.agents/rules/base.md',
						isEnabled: true,
						source: 'claude',
					},
					{
						name: 'legacy.md',
						path: '.agents/rules/disabled/legacy.md',
						isEnabled: false,
						source: 'claude',
					},
					{
						name: 'default.md',
						path: '.opencode/agent/default.md',
						isEnabled: true,
						source: 'opencode',
					},
				],
			});
		} else if (msg.type === 'importRulesFromClaude') {
			dispatchGlobalMessage('tool_result', {
				toolName: 'Import Rules',
				toolUseId: createId('t'),
				content: 'Imported legacy rules into .agents/rules/',
				isError: false,
			});
			mockVSCodeApi.postMessage({ type: 'getRules' });
		} else if (msg.type === 'syncRulesToClaude') {
			dispatchGlobalMessage('tool_result', {
				toolName: 'Sync Rules',
				toolUseId: createId('t'),
				content: 'Synced .agents/rules/ to .claude/rules/',
				isError: false,
			});
		} else if (msg.type === 'toggleRule') {
			const { path: rulePath, enabled } = msg as { path?: string; enabled?: boolean };
			if (rulePath && enabled !== undefined) {
				dispatchGlobalMessage('ruleUpdated', {
					rule: {
						name: rulePath.split('/').pop() ?? rulePath,
						path: rulePath,
						isEnabled: enabled,
						source: rulePath.includes('.opencode') ? 'opencode' : 'claude',
					},
				});
				// Keep list in sync (simple emulation)
				mockVSCodeApi.postMessage({ type: 'getRules' });
			}
		} else if (msg.type === 'createRule') {
			const { name } = msg as { name?: string };
			dispatchGlobalMessage('ruleUpdated', {
				rule: {
					name: name ?? 'new-rule.md',
					path: `.claude/rules/${name ?? 'new-rule.md'}`,
					isEnabled: true,
					source: 'claude',
				},
			});
			mockVSCodeApi.postMessage({ type: 'getRules' });
		} else if (msg.type === 'getPermissions') {
			dispatchGlobalMessage('permissionsUpdated', {
				policies: { edit: 'allow', terminal: 'allow', network: 'allow' },
			});
		} else if (msg.type === 'setPermissions') {
			const { policies } = msg as {
				policies?: { edit: string; terminal: string; network: string };
			};
			if (policies) {
				dispatchGlobalMessage('permissionsUpdated', { policies });
			}
		} else if (msg.type === 'createClaudeShim') {
			// Simulate shim creation affecting discovery
			mockVSCodeApi.postMessage({ type: 'checkDiscoveryStatus' });
		} else if (msg.type === 'reloadAllProviders') {
			// Unified handler for reloading all providers
			mockVSCodeApi.postMessage({ type: 'loadOpenCodeProviders' });
			mockVSCodeApi.postMessage({ type: 'loadAvailableProviders' });
		} else if (msg.type === 'loadOpenCodeProviders') {
			// Mock connected OpenCode providers
			dispatchGlobalMessage('openCodeProviders', {
				providers: [
					{
						id: 'anthropic',
						name: 'Anthropic',
						isCustom: false,
						models: [
							{
								id: 'claude-opus-4-5',
								name: 'Claude Opus 4.5',
								reasoning: true,
								limit: { context: 200000 },
							},
							{
								id: 'claude-sonnet-4-5',
								name: 'Claude Sonnet 4.5',
								reasoning: true,
								limit: { context: 200000 },
							},
							{
								id: 'claude-haiku-4-5',
								name: 'Claude Haiku 4.5',
								reasoning: false,
								limit: { context: 200000 },
							},
						],
					},
					{
						id: 'google',
						name: 'Google AI',
						isCustom: false,
						models: [
							{
								id: 'gemini-2.0-flash',
								name: 'Gemini 2.0 Flash',
								reasoning: true,
								limit: { context: 200000 },
							},
							{
								id: 'gemini-1.5-pro',
								name: 'Gemini 1.5 Pro',
								reasoning: false,
								limit: { context: 200000 },
							},
						],
					},
				],
				config: { isLoading: false },
			});
		} else if (msg.type === 'loadAvailableProviders') {
			// Mock available providers (not yet connected)
			dispatchGlobalMessage('availableProviders', {
				providers: [
					{ id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] },
					{ id: 'openrouter', name: 'OpenRouter', env: ['OPENROUTER_API_KEY'] },
					{ id: 'mistral', name: 'Mistral AI', env: ['MISTRAL_API_KEY'] },
					{ id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'] },
					{ id: 'deepseek', name: 'DeepSeek', env: ['DEEPSEEK_API_KEY'] },
					{ id: 'together', name: 'Together AI', env: ['TOGETHER_API_KEY'] },
					{ id: 'fireworks', name: 'Fireworks AI', env: ['FIREWORKS_API_KEY'] },
					{ id: 'perplexity', name: 'Perplexity', env: ['PERPLEXITY_API_KEY'] },
					{ id: 'cohere', name: 'Cohere', env: ['COHERE_API_KEY'] },
					{ id: 'azure', name: 'Azure OpenAI', env: ['AZURE_OPENAI_API_KEY'] },
					{
						id: 'bedrock',
						name: 'AWS Bedrock',
						env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
					},
					{ id: 'vertex', name: 'Google Vertex AI', env: ['GOOGLE_APPLICATION_CREDENTIALS'] },
				],
			});
		} else if (msg.type === 'loadProxyModels') {
			// Mock proxy models fetch
			setTimeout(() => {
				dispatchGlobalMessage('proxyModels', {
					models: [
						{ id: 'gpt-4o', name: 'GPT-4o', contextLength: 228000 },
						{ id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextLength: 228000 },
						{ id: 'llama-3.1-70b', name: 'Llama 3.1 70B', contextLength: 131072 },
						{ id: 'mixtral-8x7b', name: 'Mixtral 8x7B', contextLength: 32768 },
					],
					baseUrl: 'http://localhost:11434',
				});
			}, 500);
		} else if (msg.type === 'checkOpenCodeStatus') {
			dispatchGlobalMessage('openCodeStatus', {
				installed: true,
				version: '0.1.0',
			});
		} else if (msg.type === 'getAccess') {
			dispatchGlobalMessage('accessData', []);
		} else if (msg.type === 'getCommands') {
			dispatchGlobalMessage('commandsList', { custom: [], isLoading: false });
		} else if (msg.type === 'setOpenCodeProviderAuth') {
			// Mock provider auth
			const { providerId } = msg as { providerId?: string };
			setTimeout(() => {
				dispatchGlobalMessage('openCodeAuthResult', {
					providerId,
					isLoading: false,
					success: true,
				});
				// Reload providers after successful auth
				setTimeout(() => {
					mockVSCodeApi.postMessage({ type: 'reloadAllProviders' });
				}, 500);
			}, 1000);
		} else if (msg.type === 'updateSettings') {
			console.log('[Mock VS Code] Settings updated:', msg);
			// Echo back updated settings
			const settings = (msg as { settings?: Record<string, unknown> }).settings || {};
			if (settings.provider) {
				dispatchGlobalMessage('settingsData', {
					provider: settings.provider,
				});
				// Reload providers when provider changes
				if (settings.provider === 'opencode') {
					setTimeout(() => {
						mockVSCodeApi.postMessage({ type: 'reloadAllProviders' });
					}, 100);
				}
			}
		} else if (msg.type === 'restoreCommit') {
			// Handle restore commit message
			const data = msg.data as
				| string
				| {
						messageId: string;
						sessionId: string;
						cliSessionId?: string;
						associatedMessageId?: string;
				  };
			console.log('[Mock VS Code] Restore commit requested:', data);

			// Simulate restore operation
			setTimeout(() => {
				const targetSessionId = typeof data === 'object' ? data.sessionId : mockActiveSessionId;

				if (typeof data === 'object' && 'associatedMessageId' in data) {
					// OpenCode checkpoint restore
					// Delete messages after the user message
					dispatchSessionEvent(targetSessionId, 'delete_messages_after', {
						messageId: data.associatedMessageId,
					});

					// Send restore success
					dispatchRestore(targetSessionId, 'success', {
						message: 'Files restored. Click on your message to edit and resend.',
						canUnrevert: true,
					});

					// Notify UI that unrevert is available
					dispatchRestore(targetSessionId, 'unrevert_available', {
						available: true,
					});

					// Update restore commits list (remove the restored checkpoint)
					dispatchRestore(targetSessionId, 'set_commits', { commits: [] });
				} else if (typeof data === 'string') {
					// Git-based restore
					dispatchRestore(targetSessionId, 'success', {
						message: `Restored to commit: ${data}`,
						canUnrevert: false,
					});
					dispatchRestore(targetSessionId, 'set_commits', { commits: [] });
				}
			}, 300);
		} else if (msg.type === 'unrevert') {
			// Handle unrevert message
			const data = msg.data as { sessionId: string; cliSessionId?: string } | undefined;
			console.log('[Mock VS Code] Unrevert requested:', data);

			// Simulate unrevert operation
			setTimeout(() => {
				if (data?.sessionId) {
					// Restore messages from snapshot (simulate)
					const restoredMessages: Array<{
						type: string;
						content: string;
						id: string;
						timestamp: string;
					}> = [
						{
							type: 'assistant',
							content: 'Previous response restored',
							id: createId('assistant'),
							timestamp: new Date().toISOString(),
						},
					];

					dispatchSessionEvent(data.sessionId, 'messages_reload', {
						messages: restoredMessages,
					});

					dispatchRestore(data.sessionId, 'success', {
						message: 'Previous state restored',
						canUnrevert: false,
					});

					// Clear unrevert availability
					dispatchRestore(data.sessionId, 'unrevert_available', {
						available: false,
					});
				}
			}, 300);
		}
	},
	getState: () => mockState,
	setState: (state: unknown) => {
		mockState = state as Record<string, unknown>;
	},
};

export function initMockVSCode(): void {
	window.vscode = mockVSCodeApi;
	window.acquireVsCodeApi = () => mockVSCodeApi;

	const rootStyle = document.documentElement.style;
	const theme = {
		// Fonts
		'--vscode-font-family':
			'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
		'--vscode-editor-font-family': '"SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", monospace',
		'--vscode-font-size': '13px',
		'--vscode-editor-font-size': '13px',

		// Core colors
		'--vscode-foreground': '#CCCCCC',
		'--vscode-descriptionForeground': '#9D9D9D',
		'--vscode-disabledForeground': '#6E7681',
		'--vscode-errorForeground': '#F85149',
		'--vscode-icon-foreground': '#CCCCCC',

		// Editor
		'--vscode-editor-background': '#1F1F1F',
		'--vscode-editor-foreground': '#CCCCCC',

		// Sidebar
		'--vscode-sideBar-background': '#181818',
		'--vscode-sideBar-foreground': '#CCCCCC',
		'--vscode-sideBar-border': '#2B2B2B',
		'--vscode-sideBarTitle-foreground': '#CCCCCC',
		'--vscode-sideBarSectionHeader-background': '#181818',
		'--vscode-sideBarSectionHeader-foreground': '#CCCCCC',
		'--vscode-sideBarSectionHeader-border': '#2B2B2B',

		// Panel
		'--vscode-panel-background': '#181818',
		'--vscode-panel-border': '#2B2B2B',

		// Input
		'--vscode-input-background': '#313131',
		'--vscode-input-foreground': '#CCCCCC',
		'--vscode-input-border': '#3C3C3C',
		'--vscode-input-placeholderForeground': '#989898',
		'--vscode-inputOption-activeBackground': '#2489DB82',
		'--vscode-inputOption-activeBorder': '#2488DB',

		// Button
		'--vscode-button-background': '#0078D4',
		'--vscode-button-foreground': '#FFFFFF',
		'--vscode-button-hoverBackground': '#026EC1',
		'--vscode-button-border': '#FFFFFF12',
		'--vscode-button-secondaryBackground': '#313131',
		'--vscode-button-secondaryForeground': '#CCCCCC',
		'--vscode-button-secondaryHoverBackground': '#3C3C3C',

		// Dropdown
		'--vscode-dropdown-background': '#313131',
		'--vscode-dropdown-foreground': '#CCCCCC',
		'--vscode-dropdown-border': '#3C3C3C',
		'--vscode-dropdown-listBackground': '#1F1F1F',

		// List
		'--vscode-list-hoverBackground': '#2A2D2E',
		'--vscode-list-activeSelectionBackground': '#04395E',
		'--vscode-list-activeSelectionForeground': '#FFFFFF',
		'--vscode-list-inactiveSelectionBackground': '#37373D',
		'--vscode-list-focusBackground': '#04395E',

		// Focus & borders
		'--vscode-focusBorder': '#0078D4',
		'--vscode-widget-border': '#313131',
		'--vscode-contrastBorder': '#2B2B2B',

		// Links
		'--vscode-textLink-foreground': '#4DAAFC',
		'--vscode-textLink-activeForeground': '#4DAAFC',

		// Toolbar
		'--vscode-toolbar-hoverBackground': '#5A5D5E50',

		// Badge
		'--vscode-badge-background': '#616161',
		'--vscode-badge-foreground': '#F8F8F8',

		// Activity bar
		'--vscode-activityBar-background': '#181818',
		'--vscode-activityBar-foreground': '#D7D7D7',
		'--vscode-activityBar-inactiveForeground': '#868686',
		'--vscode-activityBar-border': '#2B2B2B',
		'--vscode-activityBar-activeBorder': '#0078D4',
		'--vscode-activityBarBadge-background': '#0078D4',
		'--vscode-activityBarBadge-foreground': '#FFFFFF',

		// Checkbox
		'--vscode-checkbox-background': '#313131',
		'--vscode-checkbox-border': '#3C3C3C',

		// Tabs
		'--vscode-tab-activeBackground': '#1F1F1F',
		'--vscode-tab-activeForeground': '#FFFFFF',
		'--vscode-tab-inactiveBackground': '#181818',
		'--vscode-tab-inactiveForeground': '#9D9D9D',
		'--vscode-tab-border': '#2B2B2B',
		'--vscode-tab-activeBorderTop': '#0078D4',
		'--vscode-tab-hoverBackground': '#1F1F1F',

		// Title bar
		'--vscode-titleBar-activeBackground': '#181818',
		'--vscode-titleBar-activeForeground': '#CCCCCC',
		'--vscode-titleBar-inactiveBackground': '#1F1F1F',
		'--vscode-titleBar-inactiveForeground': '#9D9D9D',
		'--vscode-titleBar-border': '#2B2B2B',

		// Status bar
		'--vscode-statusBar-background': '#181818',
		'--vscode-statusBar-foreground': '#CCCCCC',
		'--vscode-statusBar-border': '#2B2B2B',
		'--vscode-statusBarItem-hoverBackground': '#F1F1F133',
		'--vscode-statusBarItem-hoverForeground': '#FFFFFF',

		// Editor widget (tooltips, etc.)
		'--vscode-editorWidget-background': '#202020',
		'--vscode-editorWidget-foreground': '#CCCCCC',
		'--vscode-editorWidget-border': '#313131',

		// Notifications
		'--vscode-notifications-background': '#1F1F1F',
		'--vscode-notifications-foreground': '#CCCCCC',
		'--vscode-notifications-border': '#2B2B2B',
		'--vscode-notificationCenterHeader-background': '#1F1F1F',
		'--vscode-notificationCenterHeader-foreground': '#CCCCCC',

		// Quick input
		'--vscode-quickInput-background': '#222222',
		'--vscode-quickInput-foreground': '#CCCCCC',

		// Menu
		'--vscode-menu-background': '#1F1F1F',
		'--vscode-menu-foreground': '#CCCCCC',
		'--vscode-menu-selectionBackground': '#0078D4',
		'--vscode-menu-selectionForeground': '#FFFFFF',

		// Scrollbar
		'--vscode-scrollbarSlider-background': '#79797966',
		'--vscode-scrollbarSlider-hoverBackground': '#646464B3',
		'--vscode-scrollbarSlider-activeBackground': '#BFBFBF66',

		// Terminal
		'--vscode-terminal-foreground': '#CCCCCC',
		'--vscode-terminal-background': '#181818',

		// Text
		'--vscode-textBlockQuote-background': '#2B2B2B',
		'--vscode-textBlockQuote-border': '#616161',
		'--vscode-textCodeBlock-background': '#2B2B2B',
		'--vscode-textPreformat-foreground': '#D0D0D0',
		'--vscode-textPreformat-background': '#3C3C3C',

		// Progress bar
		'--vscode-progressBar-background': '#0078D4',

		// Settings
		'--vscode-settings-dropdownBackground': '#313131',
		'--vscode-settings-dropdownBorder': '#3C3C3C',
		'--vscode-settings-headerForeground': '#FFFFFF',

		// Welcome page
		'--vscode-welcomePage-tileBackground': '#2B2B2B',

		// Editor gutter
		'--vscode-editorGutter-addedBackground': '#2EA043',
		'--vscode-editorGutter-deletedBackground': '#F85149',
		'--vscode-editorGutter-modifiedBackground': '#0078D4',

		// Editor line numbers
		'--vscode-editorLineNumber-foreground': '#6E7681',
		'--vscode-editorLineNumber-activeForeground': '#CCCCCC',

		// Custom app colors
		'--changed-files-added': '#089981',
		'--changed-files-removed': '#f23645',
	};

	for (const [key, value] of Object.entries(theme)) {
		rootStyle.setProperty(key, value);
	}

	console.log('[Mock VS Code] Initialized INTERACTIVE API with Dark Modern theme');
}

export function addSampleMessages(): void {}
