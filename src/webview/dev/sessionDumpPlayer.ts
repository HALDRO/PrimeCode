/**
 * @file Session Dump Player
 * @description Converts OpenCode session dumps (from docs/debug/*.json) into
 *              mock webview messages and replays them in real-time.
 *              This replaces hardcoded scenarios with real session data.
 */

import type { NormalizedEntry } from '../../common/normalizedTypes';

// =============================================================================
// Types — OpenCode Dump Format
// =============================================================================

export interface SessionDump {
	session: DumpSession;
	messages: DumpMessage[];
	children: DumpChild[];
	_meta: DumpMeta;
}

interface DumpSession {
	id: string;
	slug?: string;
	title?: string;
	time: { created: number; updated: number };
	summary?: { additions?: number; deletions?: number; files?: number };
}

interface DumpMeta {
	dumpedAt: string;
	serverUrl: string;
	sessionId: string;
	directory: string;
	childCount: number;
	totalMessages: number;
}

interface DumpChild {
	session: DumpSession & { parentID?: string };
	messages: DumpMessage[];
}

export interface DumpMessage {
	info: DumpMessageInfo;
	parts: DumpPart[];
}

interface DumpMessageInfo {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	time: { created: number; completed?: number };
	parentID?: string;
	modelID?: string;
	providerID?: string;
	agent?: string;
	cost?: number;
	tokens?: {
		total: number;
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
	finish?: string;
	summary?: { title?: string; diffs?: Array<{ file: string }> };
}

export type DumpPart =
	| DumpTextPart
	| DumpToolPart
	| DumpStepStartPart
	| DumpStepFinishPart
	| DumpFilePart;

interface DumpTextPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: 'text';
	text: string;
	time?: { start: number; end: number };
}

interface DumpToolPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: 'tool';
	callID: string;
	tool: string;
	state: {
		status: 'pending' | 'running' | 'completed' | 'error';
		input?: Record<string, unknown>;
		output?: string;
		title?: string;
		metadata?: Record<string, unknown>;
		time?: { start: number; end: number; compacted?: number };
	};
}

interface DumpStepStartPart {
	id: string;
	type: 'step-start';
	snapshot?: string;
}

interface DumpStepFinishPart {
	id: string;
	type: 'step-finish';
	reason?: string;
	snapshot?: string;
	cost?: number;
	tokens?: {
		total: number;
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
}

interface DumpFilePart {
	id: string;
	sessionID: string;
	messageID: string;
	type: 'file';
	mime: string;
	url: string;
	filename?: string;
}

// =============================================================================
// Types — Mock Message Format (what webview expects)
// =============================================================================

interface MockMessage {
	type: 'session_event' | 'session_lifecycle';
	delay?: number;
	targetId?: string;
	eventType?: string;
	payload?: unknown;
	timestamp?: number;
	action?: 'created' | 'closed' | 'switched' | 'cleared';
	sessionId?: string;
	data?: Record<string, unknown>;
}

function createSessionEvent(
	targetId: string,
	eventType: string,
	payload: Record<string, unknown>,
	delay: number,
): MockMessage {
	return {
		type: 'session_event',
		targetId,
		eventType,
		payload: { eventType, ...payload },
		timestamp: Date.now(),
		delay,
	};
}

function createUserMessageEvent(
	targetId: string,
	message: Record<string, unknown>,
	delay: number,
): MockMessage {
	return createSessionEvent(targetId, 'user_message', { message }, delay);
}

function createSubtaskEvent(
	targetId: string,
	subtask: Record<string, unknown>,
	delay: number,
): MockMessage {
	return createSessionEvent(targetId, 'subtask', { subtask }, delay);
}

function createMessageRecordEvent(
	targetId: string,
	message: Record<string, unknown>,
	delay: number,
): MockMessage {
	return createSessionEvent(targetId, 'message_record', { message }, delay);
}

function createMessagePartEvent(
	targetId: string,
	part: Record<string, unknown>,
	delay: number,
): MockMessage {
	return createSessionEvent(targetId, 'message_part', { part }, delay);
}

// =============================================================================
// Playback Configuration
// =============================================================================

export interface PlaybackConfig {
	/** Base delay between messages in ms (default: 300) */
	baseDelay: number;
	/** Delay for tool calls (default: 500) */
	toolDelay: number;
	/** Delay for text/assistant messages (default: 400) */
	textDelay: number;
	/** Delay for thinking blocks (default: 600) */
	thinkingDelay: number;
	/** Speed multiplier: 1 = normal, 2 = 2x faster, 0.5 = 2x slower */
	speed: number;
	/** Max messages to replay (0 = all) */
	maxMessages: number;
	/** Whether to include child sessions (subtasks) */
	includeChildren: boolean;
}

export const DEFAULT_PLAYBACK_CONFIG: PlaybackConfig = {
	baseDelay: 300,
	toolDelay: 500,
	textDelay: 400,
	thinkingDelay: 600,
	speed: 1,
	maxMessages: 0,
	includeChildren: true,
};

// =============================================================================
// Tool Name → NormalizedEntry Converter
// =============================================================================

function normalizeToolName(tool: string): string {
	const lower = tool.toLowerCase();
	const map: Record<string, string> = {
		read: 'Read',
		read_file: 'Read',
		readfile: 'Read',
		write: 'Write',
		write_file: 'Write',
		writefile: 'Write',
		edit: 'Edit',
		edit_file: 'Edit',
		editfile: 'Edit',
		patch: 'Edit',
		bash: 'Bash',
		run_command: 'Bash',
		grep: 'Grep',
		glob: 'Glob',
		list: 'List',
		list_dir: 'List',
		ls: 'List',
		task: 'Task',
		todo_write: 'TodoWrite',
		todowrite: 'TodoWrite',
		webfetch: 'WebFetch',
		web_fetch: 'WebFetch',
	};
	return map[lower] || tool;
}

function buildNormalizedEntry(part: DumpToolPart): NormalizedEntry | undefined {
	const tool = normalizeToolName(part.tool);
	const input = part.state.input || {};
	const status =
		part.state.status === 'completed'
			? 'success'
			: part.state.status === 'error'
				? 'failed'
				: 'created';

	const base = {
		timestamp: new Date(part.state.time?.start || Date.now()).toISOString(),
		content: '',
	};

	switch (tool) {
		case 'Read':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'FileRead',
						path: (input.filePath as string) || (input.path as string) || '',
						offset: input.offset as number | undefined,
						limit: input.limit as number | undefined,
					},
				},
			};
		case 'Write':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'FileEdit',
						path: (input.filePath as string) || (input.file_path as string) || '',
						changes: [{ type: 'Write', content: (input.content as string) || '' }],
					},
				},
			};
		case 'Edit':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'FileEdit',
						path: (input.filePath as string) || (input.file_path as string) || '',
						changes: [
							{
								type: 'Replace',
								oldContent: (input.old_string as string) || '',
								newContent: (input.new_string as string) || '',
							},
						],
					},
				},
			};
		case 'Bash':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'CommandRun',
						command: (input.command as string) || '',
						result: part.state.output
							? {
									output: part.state.output,
									exitStatus: { type: 'Success', success: status === 'success' },
								}
							: undefined,
					},
				},
			};
		case 'Grep':
		case 'Glob':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'Search',
						query: (input.pattern as string) || (input.query as string) || '',
					},
				},
			};
		case 'Task':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'TaskCreate',
						description: (input.description as string) || (input.prompt as string) || '',
					},
				},
			};
		case 'TodoWrite':
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: {
						type: 'TodoManagement',
						todos: Array.isArray(input.todos)
							? (input.todos as Array<{ content: string; status: string }>)
							: [],
						operation: (input.merge as boolean) ? 'update' : 'create',
					},
				},
			};
		default:
			// MCP tools or unknown — generic Tool
			return {
				...base,
				entryType: {
					type: 'ToolUse',
					toolName: tool,
					status,
					actionType: { type: 'Tool', toolName: tool, arguments: input },
				},
			};
	}
}

// =============================================================================
// Dump → Mock Message Converter
// =============================================================================

/** Convert a single dump part into one or more MockMessages */
function convertPart(
	part: DumpPart,
	messageInfo: DumpMessageInfo,
	sessionId: string,
	config: PlaybackConfig,
): MockMessage[] {
	const messages: MockMessage[] = [];

	switch (part.type) {
		case 'text': {
			if (!part.text?.trim()) break;
			if (messageInfo.role === 'assistant') {
				messages.push(
					createMessagePartEvent(
						sessionId,
						{
							id: part.id || messageInfo.id,
							messageId: messageInfo.id,
							sessionId,
							type: 'text',
							text: part.text,
							createdAt: part.time?.start || messageInfo.time.created,
							completedAt: part.time?.end || messageInfo.time.completed,
						},
						Math.round(config.textDelay / config.speed),
					),
				);
			}
			break;
		}

		case 'tool': {
			const toolName = normalizeToolName(part.tool);
			const toolUseId = part.callID;
			const normalizedEntry = buildNormalizedEntry(part);

			messages.push(
				createMessagePartEvent(
					sessionId,
					{
						id: part.id,
						messageId: messageInfo.id,
						sessionId,
						type: 'tool',
						callId: toolUseId,
						toolName,
						state: {
							status: part.state.status,
							input: part.state.input || {},
							output: part.state.output,
							title: part.state.title,
							metadata: part.state.metadata,
						},
						createdAt: part.state.time?.start || messageInfo.time.created,
						completedAt: part.state.time?.end,
						normalizedEntry: normalizedEntry as NormalizedEntry | undefined,
					},
					Math.round(config.toolDelay / config.speed),
				),
			);

			if (part.state.status === 'completed' || part.state.status === 'error') {
				const filePath = extractFilePath(part);
				if (filePath && ['Write', 'Edit'].includes(toolName)) {
					messages.push(
						createSessionEvent(
							sessionId,
							'file',
							{
								action: 'changed',
								filePath,
								fileName: filePath.split(/[/\\]/).pop() || filePath,
								toolUseId,
							},
							50,
						),
					);
				}
			}
			break;
		}

		case 'step-start':
		case 'step-finish':
			// Step markers are structural — we skip them in playback.
			// Token stats from step-finish are aggregated at session level.
			break;

		default:
			break;
	}

	return messages;
}

/** Extract file path from a tool part's input */
function extractFilePath(part: DumpToolPart): string | undefined {
	const input = part.state.input || {};
	return (
		(input.filePath as string) || (input.file_path as string) || (input.path as string) || undefined
	);
}

// =============================================================================
// Session → Full MockMessage Sequence
// =============================================================================

/** Convert an entire dump session (messages array) into a flat MockMessage sequence */
function convertSession(
	messages: DumpMessage[],
	sessionId: string,
	config: PlaybackConfig,
): MockMessage[] {
	const result: MockMessage[] = [];
	const limit = config.maxMessages > 0 ? config.maxMessages : messages.length;

	for (let i = 0; i < Math.min(messages.length, limit); i++) {
		const msg = messages[i];
		const createdAt = msg.info.time.created;
		const completedAt = msg.info.time.completed;
		const timestamp = new Date(createdAt).toISOString();

		result.push(
			createMessageRecordEvent(
				sessionId,
				{
					id: msg.info.id,
					sessionId,
					role: msg.info.role,
					parentId: msg.info.parentID,
					createdAt,
					completedAt,
					modelId: msg.info.modelID,
					providerId: msg.info.providerID,
					agent: msg.info.agent,
					tokens: msg.info.tokens
						? {
								input: msg.info.tokens.input,
								output: msg.info.tokens.output,
								reasoning: msg.info.tokens.reasoning,
								cacheRead: msg.info.tokens.cache.read,
								cacheWrite: msg.info.tokens.cache.write,
								total: msg.info.tokens.total,
							}
						: undefined,
					cost: msg.info.cost,
				},
				Math.round((config.baseDelay * 0.25) / config.speed),
			),
		);

		// For user messages, emit the user message from summary or first text part
		if (msg.info.role === 'user') {
			const textPart = msg.parts.find((p): p is DumpTextPart => p.type === 'text');
			const content = textPart?.text || msg.info.summary?.title || '(user message)';

			result.push(
				createUserMessageEvent(
					sessionId,
					{
						id: msg.info.id,
						content,
						timestamp,
						model: msg.info.modelID,
						agent: msg.info.agent,
					},
					Math.round(config.baseDelay / config.speed),
				),
			);

			// Emit checkpoint/restore after user message
			result.push(
				createSessionEvent(
					sessionId,
					'restore',
					{
						action: 'add_commit',
						commit: {
							id: `checkpoint-${msg.info.id}`,
							sha: msg.info.id.replace('msg_', ''),
							message: 'Checkpoint before message',
							timestamp,
							associatedMessageId: msg.info.id,
						},
					},
					Math.round(100 / config.speed),
				),
			);
			continue;
		}

		// For assistant messages, convert each part
		for (const part of msg.parts) {
			const converted = convertPart(part, msg.info, sessionId, config);
			result.push(...converted);
		}

		// Emit token stats after each assistant message with tokens
		if (msg.info.tokens) {
			result.push(
				createSessionEvent(
					sessionId,
					'stats',
					{
						totalStats: {
							contextTokens: msg.info.tokens.input,
							outputTokens: msg.info.tokens.output,
							totalTokens: msg.info.tokens.total,
							cacheReadTokens: msg.info.tokens.cache?.read || 0,
							cacheCreationTokens: msg.info.tokens.cache?.write || 0,
							reasoningTokens: msg.info.tokens.reasoning || 0,
							totalCost: msg.info.cost || 0,
						},
					},
					Math.round(50 / config.speed),
				),
			);
		}
	}

	return result;
}

// =============================================================================
// Public API — Session Dump Player
// =============================================================================

export interface DumpPlayer {
	/** The mock session ID used for playback */
	sessionId: string;
	/** Session title from the dump */
	title: string;
	/** Total message count */
	messageCount: number;
	/** Child session count */
	childCount: number;
	/** Get the initial scenario (played on webviewDidLaunch) */
	getMainScenario(): MockMessage[];
	/** Get child session scenarios (keyed by contextId) */
	getChildScenarios(): Map<string, { title: string; messages: MockMessage[] }>;
	/** Get all scenarios merged into a single timeline with subtask cards */
	getMergedTimeline(): MockMessage[];
	/** Playback config */
	config: PlaybackConfig;
}

/**
 * Create a dump player from a session dump JSON.
 * The returned player provides MockMessage sequences ready for `runScenario()`.
 */
export function createDumpPlayer(
	dump: SessionDump,
	mockSessionId: string,
	configOverrides?: Partial<PlaybackConfig>,
): DumpPlayer {
	const config = { ...DEFAULT_PLAYBACK_CONFIG, ...configOverrides };
	const title = dump.session.title || dump.session.slug || 'Untitled Session';

	const mainMessages = convertSession(dump.messages, mockSessionId, config);

	const childScenarios = new Map<string, { title: string; messages: MockMessage[] }>();
	if (config.includeChildren) {
		for (const child of dump.children) {
			const childTitle = child.session.title || child.session.slug || 'Subtask';
			const contextId = child.session.id;
			const childMsgs = convertSession(child.messages, contextId, config);
			childScenarios.set(contextId, { title: childTitle, messages: childMsgs });
		}
	}

	return {
		sessionId: mockSessionId,
		title,
		messageCount: dump.messages.length,
		childCount: dump.children.length,
		config,

		getMainScenario() {
			return mainMessages;
		},

		getChildScenarios() {
			return childScenarios;
		},

		getMergedTimeline() {
			return buildMergedTimeline(dump, mockSessionId, childScenarios, mainMessages, config);
		},
	};
}

/**
 * Build a merged timeline that interleaves parent messages with subtask cards
 * and child session events, matching the real-time experience.
 */
function buildMergedTimeline(
	dump: SessionDump,
	mockSessionId: string,
	childScenarios: Map<string, { title: string; messages: MockMessage[] }>,
	mainMessages: MockMessage[],
	config: PlaybackConfig,
): MockMessage[] {
	const timeline: MockMessage[] = [];

	// Walk through main messages, injecting subtask cards where children appear
	const injectedChildren = new Set<string>();

	for (const msg of mainMessages) {
		timeline.push(msg);

		// After each task tool part, inject the child session
		const payload = msg.payload as Record<string, unknown> | undefined;
		const part = (payload?.part as Record<string, unknown>) || {};
		const toolName = part.toolName as string | undefined;
		const partType = part.type as string | undefined;

		if (toolName === 'Task' && partType === 'tool') {
			// Find matching child by creation time proximity
			for (const child of dump.children) {
				if (injectedChildren.has(child.session.id)) continue;
				injectedChildren.add(child.session.id);

				const contextId = child.session.id;
				const childTitle = child.session.title || 'Subtask';

				// NOTE: Do NOT emit session_lifecycle:created for child sessions —
				// it causes the UI to open a new tab. Child sessions should only
				// appear as subtask cards within the parent session.

				// Subtask start card
				timeline.push(
					createSubtaskEvent(
						mockSessionId,
						{
							id: `subtask-${contextId}`,
							agent: child.session.slug || 'explore',
							prompt: childTitle,
							description: 'Running...',
							status: 'running',
							childSessionId: contextId,
							timestamp: new Date(child.session.time.created).toISOString(),
						},
						Math.round(config.baseDelay / config.speed),
					),
				);

				// Inject child messages
				const childData = childScenarios.get(contextId);
				if (childData) {
					timeline.push(...childData.messages);
				}

				// Subtask complete card
				timeline.push(
					createSubtaskEvent(
						mockSessionId,
						{
							id: `subtask-${contextId}`,
							agent: child.session.slug || 'explore',
							prompt: childTitle,
							description: 'Complete',
							status: 'completed',
							result: childTitle,
							childSessionId: contextId,
							timestamp: new Date(
								child.session.time.updated || child.session.time.created,
							).toISOString(),
						},
						Math.round(config.baseDelay / config.speed),
					),
				);

				break; // One child per task tool call
			}
		}
	}

	// Inject any remaining children that weren't matched to Task tool calls
	for (const child of dump.children) {
		if (injectedChildren.has(child.session.id)) continue;
		injectedChildren.add(child.session.id);

		const contextId = child.session.id;
		const childTitle = child.session.title || 'Subtask';
		const childData = childScenarios.get(contextId);

		timeline.push({
			type: 'session_lifecycle',
			action: 'created',
			sessionId: contextId,
			data: { isContext: true, parentSessionId: mockSessionId },
			delay: Math.round(100 / config.speed),
		});

		timeline.push(
			createSubtaskEvent(
				mockSessionId,
				{
					id: `subtask-${contextId}`,
					agent: child.session.slug || 'explore',
					prompt: childTitle,
					description: 'Running...',
					status: 'running',
					childSessionId: contextId,
					timestamp: new Date(child.session.time.created).toISOString(),
				},
				Math.round(config.baseDelay / config.speed),
			),
		);

		if (childData) {
			timeline.push(...childData.messages);
		}

		timeline.push(
			createSubtaskEvent(
				mockSessionId,
				{
					id: `subtask-${contextId}`,
					agent: child.session.slug || 'explore',
					prompt: childTitle,
					description: 'Complete',
					status: 'completed',
					result: childTitle,
					childSessionId: contextId,
					timestamp: new Date(
						child.session.time.updated || child.session.time.created,
					).toISOString(),
				},
				Math.round(config.baseDelay / config.speed),
			),
		);
	}

	return timeline;
}

// =============================================================================
// Utility — Load dump from fetch (for browser dev mode)
// =============================================================================

/**
 * Load a session dump from a URL (e.g., /docs/debug/ses_xxx.json served by Vite).
 */
export async function loadDumpFromUrl(url: string): Promise<SessionDump> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to load dump: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<SessionDump>;
}

/**
 * List available dump files (hardcoded for now, could be dynamic).
 */
export function getAvailableDumps(): Array<{ name: string; path: string }> {
	return [
		{
			name: 'Subagent card counter bugs',
			path: '/docs/debug/ses_3962f677cffeiyzGL8EPozwaA5.json',
		},
		{
			name: 'Session dump example',
			path: '/docs/debug/session-dump-example.json',
		},
	];
}
