/**
 * @file Mock VS Code API for browser development
 * @description Provides a professional, comprehensive scenario-based mock implementation.
 *              Demonstrates all UI capabilities: complex markdown, diffs, MCP, bash, and stats.
 */

import type { VSCodeApi } from '../../types';

declare global {
	interface Window {
		vscode?: VSCodeApi;
		acquireVsCodeApi?: () => VSCodeApi;
	}
}

interface MockMessage {
	type: string;
	data?: unknown;
	delay?: number;
}

let mockState: Record<string, unknown> = {};
let activeTimers: NodeJS.Timeout[] = [];
const mockActiveSessionId = 'premium-dev-session';
let isScenarioRunning = false;
let isLaunched = false;

function createId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Dispatch a mock message to webview in the format it expects */
export function dispatchMockMessage(type: string, data?: unknown): void {
	// The extension handler (useExtensionMessages.ts) expects some types to be flat
	// and others to be nested in 'data'.
	const flatTypes = [
		'user',
		'assistant',
		'thinking',
		'tool_use',
		'tool_result',
		'access_request',
		'error',
		'subtask',
		'system_notice',
	];

	if (flatTypes.includes(type) && typeof data === 'object' && data !== null) {
		window.postMessage({ type, ...(data as object) }, '*');
	} else {
		window.postMessage({ type, data }, '*');
	}
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
		dispatchMockMessage('sessionCleared');
		await new Promise(r => setTimeout(r, 100));
	}

	// Set processing state so the UI shows the Stop button
	dispatchMockMessage('setProcessing', { isProcessing: true });
	await new Promise(r => setTimeout(r, 100));

	for (const msg of messages) {
		// If isScenarioRunning becomes false (via stopRequest), we abort
		if (!isScenarioRunning) {
			break;
		}

		await new Promise(resolve => {
			const timer = setTimeout(() => {
				dispatchMockMessage(msg.type, msg.data);
				resolve(null);
			}, msg.delay || 600);
			activeTimers.push(timer);
		});
	}

	dispatchMockMessage('setProcessing', { isProcessing: false });
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
		{
			type: 'user',
			data: {
				content:
					'# Task: System Modernization\nI need to analyze the project architecture. Please:\n1. Check `@package.json` for vulnerabilities.\n2. Update `@src/App.tsx` to handle global state.\n3. Run full test suite.',
				id: 'm1',
				timestamp: new Date().toISOString(),
			},
			delay: 100,
		},
		{
			type: 'imagePath',
			data: { filePath: 'https://placehold.co/800x450/1e1e1e/3794ff?text=Architecture+Map+v2.0' },
			delay: 400,
		},
		{
			type: 'thinking',
			data: {
				content:
					'Scanning workspace and building dependency graph...\n\nAnalyzing project structure to understand the codebase architecture. Looking for:\n- Entry points and main components\n- Utility functions and shared modules\n- Test coverage and configuration\n- Build and deployment setup',
				partId: thinkingId1,
				durationMs: 2340,
				reasoningTokens: 156,
				isStreaming: false,
			},
			delay: 800,
		},
		{
			type: 'tool_use',
			data: {
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
			},
			delay: 400,
		},
		{
			type: 'tool_result',
			data: {
				toolName: 'TodoWrite',
				toolUseId: 'todo-demo-create',
				content: 'Created todos',
				isError: false,
			},
			delay: 200,
		},
		{
			type: 'tool_use',
			data: { toolName: 'LS', toolUseId: 't1', filePath: 'src/', rawInput: { path: 'src/' } },
			delay: 400,
		},
		{
			type: 'tool_result',
			data: {
				toolName: 'LS',
				toolUseId: 't1',
				content: 'components/\nutils/\nApp.tsx\nconfig.json\nstyles.css',
				isError: false,
			},
			delay: 300,
		},
		{
			type: 'fileChanged',
			data: {
				filePath: 'src/App.tsx',
				changeType: 'modified',
				linesAdded: 3,
				linesRemoved: 2,
				toolUseId: editAppId,
			},
			delay: 100,
		},
		{
			type: 'tool_use',
			data: {
				toolName: 'Edit',
				toolUseId: editAppId,
				filePath: 'src/App.tsx',
				rawInput: {
					file_path: 'src/App.tsx',
					old_string: 'const [count, setCount] = useState(0);\nreturn <button>{count}</button>;',
					new_string:
						'const [count, setCount] = useState(0);\nconst increment = () => setCount(c => c + 1);\nreturn <button onClick={increment}>{count}</button>;',
				},
			},
			delay: 800,
		},
		{
			type: 'access_request',
			data: {
				requestId: 'acc-edit-1',
				toolUseId: editAppId,
				tool: 'Edit',
				input: {
					file_path: 'src/App.tsx',
					old_string: 'const [count, setCount] = useState(0);\nreturn <button>{count}</button>;',
					new_string:
						'const [count, setCount] = useState(0);\nconst increment = () => setCount(c => c + 1);\nreturn <button onClick={increment}>{count}</button>;',
				},
				timestamp: Date.now(),
			},
			delay: 200,
		},
		{
			type: 'tool_result',
			data: { toolName: 'Edit', toolUseId: editAppId, content: 'Updated App.tsx', isError: false },
			delay: 1000,
		},
		{
			type: 'tool_use',
			data: {
				toolName: 'mcp__google__search',
				toolUseId: googleSearchId,
				rawInput: { query: 'React 19' },
			},
			delay: 800,
		},
		{
			type: 'access_request',
			data: {
				requestId: 'acc-mcp-1',
				toolUseId: googleSearchId,
				tool: 'mcp__google__search',
				input: { query: 'React 19' },
				timestamp: Date.now(),
			},
			delay: 200,
		},
		{
			type: 'tool_result',
			data: {
				toolName: 'mcp__google__search',
				toolUseId: googleSearchId,
				content: '{"status": "ok", "results": [{"title": "React 19 RC"}]}',
				isError: false,
			},
			delay: 1000,
		},
		{
			type: 'tool_use',
			data: { toolName: 'Bash', toolUseId: 't5', rawInput: { command: 'npm test' } },
			delay: 400,
		},
		{
			type: 'access_request',
			data: {
				requestId: 'acc-1',
				toolUseId: 't5',
				tool: 'Bash',
				input: { command: 'npm test' },
				timestamp: Date.now(),
			},
			delay: 200,
		},
		{
			type: 'tool_result',
			data: {
				toolName: 'Bash',
				toolUseId: 't5',
				content: 'PASS src/App.test.tsx\nPASS src/utils/logger.test.ts',
				isError: false,
			},
			delay: 1000,
		},
		{
			type: 'tool_use',
			data: {
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
			},
			delay: 400,
		},
		{
			type: 'tool_result',
			data: {
				toolName: 'TodoWrite',
				toolUseId: 'todo-demo-complete',
				content: 'All todos completed',
				isError: false,
			},
			delay: 200,
		},
		{
			type: 'assistant',
			data: {
				content: assistantContent,
			},
			delay: 1000,
		},
		{
			type: 'updateTokens',
			data: {
				totalTokensInput: 128000,
				totalTokensOutput: 12000,
				currentInputTokens: 128000,
				currentOutputTokens: 12000,
				cacheCreationTokens: 40000,
				cacheReadTokens: 78000,
				reasoningTokens: 156,
				totalReasoningTokens: 156,
			},
			delay: 200,
		},
		{
			type: 'updateTotals',
			data: {
				totalCost: 0.158,
				totalTokensInput: 128000,
				totalTokensOutput: 12000,
				totalReasoningTokens: 156,
				requestCount: 24,
				totalDuration: 45000,
			},
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
							type: 'user',
							data: {
								content: userContent,
								id: userMessageId,
								timestamp: new Date().toISOString(),
							},
							delay: 100,
						},
						{
							type: 'system_notice',
							data: { content: noticeText, id: createId('notice') },
							delay: 450,
						},
						{
							type: 'assistant',
							data: {
								content: isCompact
									? 'Context summary complete. Continue with your next request — the conversation context is now condensed for a larger effective window.'
									: `Executed /${commandName}${args ? ` ${args}` : ''}.`,
							},
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
						type: 'user',
						data: { content: userContent, id: userMessageId, timestamp: new Date().toISOString() },
						delay: 100,
					},
					{
						type: 'thinking',
						data: {
							content:
								'Planning tasks and creating initial TODO list...\n\nI will create a short set of steps, then update their statuses as work progresses.',
							partId: thinkingPartId,
							durationMs: 900,
							reasoningTokens: 42,
							isStreaming: false,
						},
						delay: 500,
					},
					// Create (running) -> should auto-expand
					{
						type: 'tool_use',
						data: {
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
						},
						delay: 700,
					},
					{
						type: 'tool_result',
						data: {
							toolName: 'TodoWrite',
							toolUseId: todoCreateUseId,
							content: 'Created 2 todos',
							isError: false,
						},
						delay: 200,
					},
					// Update (not running) -> should stay compact by default
					{
						type: 'tool_use',
						data: {
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
						},
						delay: 900,
					},
					{
						type: 'tool_result',
						data: {
							toolName: 'TodoWrite',
							toolUseId: todoUpdateUseId,
							content: 'Updated todo statuses',
							isError: false,
						},
						delay: 200,
					},
					// Complete (not running) -> compact header shows final progress
					{
						type: 'tool_use',
						data: {
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
						},
						delay: 900,
					},
					{
						type: 'tool_result',
						data: {
							toolName: 'TodoWrite',
							toolUseId: todoCompleteUseId,
							content: 'All todos completed',
							isError: false,
						},
						delay: 200,
					},
					{
						type: 'assistant',
						data: {
							content:
								'✅ Todo demo complete. Notice: initial create auto-expands; subsequent updates stay compact unless you manually expand.',
						},
						delay: 500,
					},
				];

				runScenario(todoScenario, false);
				return;
			}

			// Demo: Handle specific commands for testing
			if (userContent.includes('new chat')) {
				const newSessionId = createId('session');
				dispatchMockMessage('sessionCreated', { sessionId: newSessionId });

				// Start a mini-scenario in the new chat
				setTimeout(() => {
					runScenario(
						[
							{
								type: 'assistant',
								data: { content: 'Hello! This is a new chat session. How can I help you?' },
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
				const dynamicScenario: MockMessage[] = [
					{
						type: 'user',
						data: { content: userContent, id: userMessageId, timestamp: new Date().toISOString() },
						delay: 100,
					},
					{
						type: 'thinking',
						data: {
							content:
								'Modifying file to demonstrate changes...\n\nPreparing to update the demo file with new content to showcase the file change tracking feature.',
							partId: createId('thinking'),
							durationMs: 1100,
							reasoningTokens: 48,
							isStreaming: false,
						},
						delay: 600,
					},
					{
						type: 'tool_use',
						data: {
							toolName: 'Edit',
							toolUseId: editId,
							filePath: 'src/demo.ts',
							rawInput: { file_path: 'src/demo.ts', old_string: '', new_string: '// Demo change' },
						},
						delay: 800,
					},
					{
						type: 'tool_result',
						data: {
							toolName: 'Edit',
							toolUseId: editId,
							content: 'Applied changes',
							isError: false,
						},
						delay: 200,
					},
					{
						type: 'fileChanged',
						data: {
							filePath: 'src/demo.ts',
							changeType: 'modified',
							linesAdded: 5,
							linesRemoved: 1,
							toolUseId: editId,
						},
						delay: 100,
					},
					{
						type: 'assistant',
						data: {
							content:
								'I have modified `src/demo.ts`. You should see the changes in the Changed Files panel.',
						},
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
				const errorScenario: MockMessage[] = [
					{
						type: 'user',
						data: { content: userContent, id: userMessageId, timestamp: new Date().toISOString() },
						delay: 100,
					},
					{
						type: 'thinking',
						data: {
							content: 'Processing request...\n\nAttempting to execute the requested operation.',
							partId: createId('thinking'),
							durationMs: 800,
							reasoningTokens: 24,
							isStreaming: false,
						},
						delay: 500,
					},
					{
						type: 'tool_use',
						data: {
							toolName: 'Bash',
							toolUseId: createId('t'),
							rawInput: { command: 'npm run build' },
						},
						delay: 400,
					},
					{
						type: 'error',
						data: {
							content: `API Error: Rate limit exceeded\n\nYou have exceeded the maximum number of requests per minute.\nPlease wait 30 seconds before retrying.\n\nRequest ID: req_abc123xyz\nTimestamp: ${new Date().toISOString()}`,
							id: createId('error'),
							timestamp: new Date().toISOString(),
						},
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
						type: 'user',
						data: { content: userContent, id: userMessageId, timestamp: new Date().toISOString() },
						delay: 100,
					},
					{
						type: 'error',
						data: {
							content: 'Connection timeout: Unable to reach the API server.',
							id: createId('error'),
							timestamp: new Date().toISOString(),
						},
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
				const toolLsId = createId('t');
				const toolReadId = createId('t');
				const thinkingId1 = createId('thinking');
				const thinkingId2 = createId('thinking');
				const thinkingId3 = createId('thinking');

				const subagentScenario: MockMessage[] = [
					{
						type: 'user',
						data: {
							content: userContent,
							id: userMessageId,
							timestamp: new Date().toISOString(),
						},
						delay: 100,
					},
					{
						type: 'assistant',
						data: {
							content:
								'I will delegate this complex refactoring task to our **Frontend Architect** sub-agent for a detailed analysis.',
						},
						delay: 500,
					},
					// 1. Subtask Start
					{
						type: 'subtask',
						data: {
							id: subtaskId,
							type: 'subtask',
							agent: 'frontend-architect',
							prompt: 'Analyze src/components/UserProfile.tsx for refactoring opportunities.',
							description: 'Analyzing component structure...',
							status: 'running',
							timestamp: new Date().toISOString(),
						},
						delay: 800,
					},
					// 2. Subtask Thinking 1
					{
						type: 'thinking',
						data: {
							content:
								'I need to explore the file structure first to understand dependencies and context.',
							partId: thinkingId1,
							id: thinkingId1,
							durationMs: 800,
							isStreaming: false,
							parentToolUseId: subtaskId,
						},
						delay: 400,
					},
					// 3. Subtask Tool: LS
					{
						type: 'tool_use',
						data: {
							toolName: 'LS',
							toolUseId: toolLsId,
							filePath: 'src/components',
							rawInput: { path: 'src/components' },
							parentToolUseId: subtaskId,
						},
						delay: 600,
					},
					{
						type: 'tool_result',
						data: {
							toolName: 'LS',
							toolUseId: toolLsId,
							content: 'UserProfile.tsx\nHeader.tsx\nFooter.tsx\nButton.tsx',
							isError: false,
							parentToolUseId: subtaskId,
							estimatedTokens: 45, // Added tokens
							durationMs: 800, // Added duration
						},
						delay: 800,
					},
					// 4. Subtask Thinking 2
					{
						type: 'thinking',
						data: {
							content:
								'Okay, I see UserProfile.tsx. Now I need to examine its content to identify monolithic patterns.',
							partId: thinkingId2,
							id: thinkingId2,
							durationMs: 1200,
							reasoningTokens: 120, // Added tokens
							isStreaming: false,
							parentToolUseId: subtaskId,
						},
						delay: 600,
					},
					// 5. Subtask Tool: Read
					{
						type: 'tool_use',
						data: {
							toolName: 'Read',
							toolUseId: toolReadId,
							filePath: 'src/components/UserProfile.tsx',
							rawInput: { path: 'src/components/UserProfile.tsx' },
							parentToolUseId: subtaskId,
						},
						delay: 800,
					},
					{
						type: 'tool_result',
						data: {
							toolName: 'Read',
							toolUseId: toolReadId,
							content:
								'export const UserProfile = () => {\n  // ... 500 lines of code ...\n  return (\n    <div>\n      <Avatar />\n      <UserInfo />\n      <Settings />\n    </div>\n  );\n};',
							isError: false,
							parentToolUseId: subtaskId,
							estimatedTokens: 850, // Added tokens
							durationMs: 1000, // Added duration
						},
						delay: 1000,
					},
					// 6. Subtask Thinking 3 (Final Analysis)
					{
						type: 'thinking',
						data: {
							content:
								'The component is indeed too large (500+ lines). It mixes presentation and logic. I recommend splitting it into `Avatar`, `UserInfo`, and `Settings` components.',
							partId: thinkingId3,
							id: thinkingId3,
							durationMs: 1500,
							isStreaming: false,
							parentToolUseId: subtaskId,
						},
						delay: 800,
					},
					// 7. Subtask Completion
					{
						type: 'subtask',
						data: {
							id: subtaskId,
							type: 'subtask',
							agent: 'frontend-architect',
							prompt: 'Analyze src/components/UserProfile.tsx for refactoring opportunities.',
							description: 'Analysis complete: 3 sub-components identified',
							status: 'completed',
							result:
								'Refactoring plan: Split UserProfile.tsx into Avatar, UserInfo, and Settings.',
							timestamp: new Date().toISOString(),
						},
						delay: 1000,
					},
					// 8. Main Assistant Final Response
					{
						type: 'assistant',
						data: {
							content:
								'The **Frontend Architect** has analyzed `UserProfile.tsx`. It recommends splitting the file into three smaller components:\n\n1.  `Avatar`\n2.  `UserInfo`\n3.  `Settings`\n\nShall I proceed with creating these files?',
						},
						delay: 600,
					},
				];
				runScenario(subagentScenario, false);
				return;
			}

			// Create dynamic scenario with user's actual message
			const dynamicScenario: MockMessage[] = [
				{
					type: 'user',
					data: {
						content: userContent,
						id: userMessageId,
						timestamp: new Date().toISOString(),
					},
					delay: 100,
				},
				{
					type: 'thinking',
					data: {
						content:
							'Processing your request...\n\nAnalyzing the input and determining the best approach to provide a helpful response.',
						partId: createId('thinking'),
						durationMs: 1500,
						reasoningTokens: 52,
						isStreaming: false,
					},
					delay: 600,
				},
				{
					type: 'assistant',
					data: {
						content: `I've received your message and processed it. Here's my response:\n\n${
							userContent.length > 50
								? 'Based on your detailed request, I have analyzed the requirements and prepared a comprehensive solution.'
								: 'What would you like me to help you with next?'
						}`,
					},
					delay: 800,
				},
				{
					type: 'updateTokens',
					data: {
						totalTokensInput: 500,
						totalTokensOutput: 150,
						currentInputTokens: 500,
						currentOutputTokens: 150,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						reasoningTokens: 52,
						totalReasoningTokens: 52,
					},
					delay: 100,
				},
			];

			runScenario(dynamicScenario, false);
		} else if (msg.type === 'stopRequest') {
			isScenarioRunning = false;
			clearAllMockTimers();
			dispatchMockMessage('setProcessing', { isProcessing: false });
			// Send interrupted message so user can resume
			dispatchMockMessage('interrupted', {
				data: {
					content: 'Processing was stopped by user',
					reason: 'user_stopped',
					id: createId('interrupted'),
					timestamp: new Date().toISOString(),
				},
			});
			console.log('[Mock VS Code] STOPPED - sent interrupted message');
		} else if (msg.type === 'resumeAfterError') {
			// Handle resume after error - simulate continuation
			const { sessionId } = msg as { sessionId?: string };
			console.log('[Mock VS Code] Resume after error for session:', sessionId);

			const resumeScenario: MockMessage[] = [
				{
					type: 'user',
					data: {
						content: 'Continue from where you left off.',
						id: createId('user'),
						timestamp: new Date().toISOString(),
					},
					delay: 100,
				},
				{
					type: 'thinking',
					data: {
						content:
							'Resuming from previous state...\n\nAnalyzing context and continuing execution.',
						partId: createId('thinking'),
						durationMs: 1200,
						reasoningTokens: 35,
						isStreaming: false,
					},
					delay: 600,
				},
				{
					type: 'assistant',
					data: {
						content:
							'I have resumed execution. The previous error has been handled and I am continuing with the task.\n\nWhat would you like me to do next?',
					},
					delay: 800,
				},
			];
			runScenario(resumeScenario, false);
		} else if (msg.type === 'dismissError') {
			// Handle dismiss error - remove the error message from UI
			const { messageId, sessionId } = msg as { messageId?: string; sessionId?: string };
			console.log('[Mock VS Code] Dismiss error:', messageId, 'session:', sessionId);

			if (messageId) {
				dispatchMockMessage('messagePartRemoved', {
					messageId,
					partId: messageId,
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
				dispatchMockMessage('accessResponse', {
					id,
					approved,
					alwaysAllow,
				});
			}
		} else if (msg.type === 'createSession') {
			const newSessionId = createId('session');
			console.log('[Mock VS Code] Creating session:', newSessionId);
			// Simulate a slight delay to mimic backend processing
			setTimeout(() => {
				dispatchMockMessage('sessionCreated', { sessionId: newSessionId });
			}, 100);
		} else if (msg.type === 'switchSession') {
			const { sessionId } = msg as unknown as { sessionId: string };
			console.log('[Mock VS Code] Switched to session:', sessionId);
		} else if (msg.type === 'closeSession') {
			const { sessionId } = msg as unknown as { sessionId: string };
			console.log('[Mock VS Code] Closed session:', sessionId);
		} else if (msg.type === 'webviewDidLaunch') {
			if (isLaunched) {
				console.log('[Mock VS Code] Already launched, skipping duplicate init');
				return;
			}
			isLaunched = true;

			setTimeout(() => {
				// 1. First create the session in the store
				dispatchMockMessage('sessionCreated', { sessionId: mockActiveSessionId });

				// 2. Then set ready state and session info
				dispatchMockMessage('ready', 'Ready');
				dispatchMockMessage('sessionInfo', {
					sessionId: mockActiveSessionId,
					model: 'anthropic/claude-opus-4-5',
					tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS', 'TodoWrite'],
					startTime: Date.now(),
				});
				dispatchMockMessage('openCodeModelSet', { model: 'anthropic/claude-opus-4-5' });
				dispatchMockMessage('workspaceInfo', { name: 'primecode' });
				dispatchMockMessage('workspaceFiles', [
					{ path: 'src/App.tsx', name: 'App.tsx', fsPath: 'C:\\src\\App.tsx' },
					{ path: 'src/utils/logger.ts', name: 'logger.ts', fsPath: 'C:\\src\\utils\\logger.ts' },
					{ path: 'package.json', name: 'package.json', fsPath: 'C:\\package.json' },
				]);
				runScenario(SCENARIO_1_RESEARCHER, true);
			}, 300);
		} else if (msg.type === 'getSettings') {
			dispatchMockMessage('settingsData', {
				provider: 'opencode', // Use opencode to show all provider features
				'primeCode.baseUrl': 'http://localhost:11434',
				'primeCode.apiKey': '',
				'primeCode.enabledModels': [],
				'opencode.agent': '',
				'opencode.enabledModels': ['anthropic/claude-opus-4-5', 'google/gemini-2.0-flash'],
				'providers.disabled': [],
			});
			dispatchMockMessage('platformInfo', { platform: 'win32', isWindows: true });
		} else if (msg.type === 'checkDiscoveryStatus') {
			dispatchMockMessage('discoveryStatus', {
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
			dispatchMockMessage('ruleList', {
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
			dispatchMockMessage('tool_result', {
				toolName: 'Import Rules',
				toolUseId: createId('t'),
				content: 'Imported legacy rules into .agents/rules/',
				isError: false,
			});
			mockVSCodeApi.postMessage({ type: 'getRules' });
		} else if (msg.type === 'syncRulesToClaude') {
			dispatchMockMessage('tool_result', {
				toolName: 'Sync Rules',
				toolUseId: createId('t'),
				content: 'Synced .agents/rules/ to .claude/rules/',
				isError: false,
			});
		} else if (msg.type === 'toggleRule') {
			const { path: rulePath, enabled } = msg as { path?: string; enabled?: boolean };
			if (rulePath && enabled !== undefined) {
				dispatchMockMessage('ruleUpdated', {
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
			dispatchMockMessage('ruleUpdated', {
				rule: {
					name: name ?? 'new-rule.md',
					path: `.claude/rules/${name ?? 'new-rule.md'}`,
					isEnabled: true,
					source: 'claude',
				},
			});
			mockVSCodeApi.postMessage({ type: 'getRules' });
		} else if (msg.type === 'getPermissions') {
			dispatchMockMessage('permissionsUpdated', {
				policies: { edit: 'allow', terminal: 'allow', network: 'allow' },
			});
		} else if (msg.type === 'setPermissions') {
			const { policies } = msg as {
				policies?: { edit: string; terminal: string; network: string };
			};
			if (policies) {
				dispatchMockMessage('permissionsUpdated', { policies });
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
			dispatchMockMessage('openCodeProviders', {
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
			dispatchMockMessage('availableProviders', {
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
				dispatchMockMessage('proxyModels', {
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
			dispatchMockMessage('openCodeStatus', {
				installed: true,
				version: '0.1.0',
			});
		} else if (msg.type === 'getAccess') {
			dispatchMockMessage('accessData', []);
		} else if (msg.type === 'getCommands') {
			dispatchMockMessage('commandsList', { custom: [], isLoading: false });
		} else if (msg.type === 'setOpenCodeProviderAuth') {
			// Mock provider auth
			const { providerId } = msg as { providerId?: string };
			setTimeout(() => {
				dispatchMockMessage('openCodeAuthResult', {
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
				dispatchMockMessage('settingsData', {
					provider: settings.provider,
				});
				// Reload providers when provider changes
				if (settings.provider === 'opencode') {
					setTimeout(() => {
						mockVSCodeApi.postMessage({ type: 'reloadAllProviders' });
					}, 100);
				}
			}
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
