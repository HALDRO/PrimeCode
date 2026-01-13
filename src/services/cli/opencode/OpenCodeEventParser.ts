/**
 * @file OpenCode Event Parser
 * @description Pure functions that transform SDK v2 events to unified CLIStreamData.
 * Uses module pattern with named exports for better tree-shaking and modern TS practices.
 * Extracted from OpenCodeService.ts during refactoring.
 * Updated to match SDK v2 event types (permission.asked, message.removed, etc.)
 */

import { logger } from '../../../utils/logger';
import type { CLIStreamData, MessagePart, ToolState } from '../../ICLIService';
import {
	CommandExecutedSchema,
	FileEditedSchema,
	FileWatcherUpdatedSchema,
	LspClientDiagnosticsSchema,
	MessagePartUpdatedSchema,
	MessageUpdatedSchema,
	OpenCodeEventSchema,
	PermissionAskedSchema,
	SessionCreatedSchema,
	SessionDiffSchema,
	SessionErrorSchema,
	validateOrLog,
} from './OpencodeSchemas';
import type { OpenCodeEvent, OpenCodeSession } from './types.js';

/** Part type mapping */
type PartType =
	| 'text'
	| 'reasoning'
	| 'tool'
	| 'file'
	| 'step-start'
	| 'step-finish'
	| 'thinking'
	| 'subtask';

/**
 * Transform an OpenCode SDK v2 event to unified CLIStreamData format.
 * Handles all event types from the SDK v2 Event union type.
 */
export function transformEvent(event: unknown, sessionId: string): CLIStreamData | null {
	if (
		!validateOrLog(OpenCodeEventSchema, event, {
			component: 'OpenCodeEventParser',
			label: 'event',
			sessionId,
			level: 'warn',
		})
	) {
		return null;
	}

	const typed = event as OpenCodeEvent;
	const props = typed.properties ?? {};

	switch (typed.type) {
		// Message events
		case 'message.part.updated':
			return handlePartUpdated(props, sessionId);

		case 'message.part.removed':
			return handlePartRemoved(props, sessionId);

		case 'message.updated':
			return handleMessageUpdated(props, sessionId);

		case 'message.removed':
			return handleMessageRemoved(props, sessionId);

		// Permission events (SDK v2 uses 'permission.asked' instead of 'permission.updated')
		case 'permission.asked':
			return handlePermissionAsked(props, sessionId);

		case 'permission.replied':
			return handlePermissionReplied(props, sessionId);

		// Session events
		case 'session.updated':
			return handleSessionUpdated(props);

		case 'session.created':
			return handleSessionCreated(props, sessionId);

		case 'session.deleted':
			return handleSessionDeleted(props, sessionId);

		case 'session.idle':
			return handleSessionIdle(props, sessionId);

		case 'session.error':
			return handleSessionError(props, sessionId);

		case 'session.status':
			return handleSessionStatus(props);

		case 'session.compacted':
			return handleSessionCompacted(props, sessionId);

		case 'session.diff':
			return handleSessionDiff(props);

		// Todo events
		case 'todo.updated':
			return handleTodoUpdated(props);

		// File events
		case 'file.edited':
			return handleFileEdited(props, sessionId);

		case 'file.watcher.updated':
			return handleFileWatcherUpdated(props, sessionId);

		// Command events
		case 'command.executed':
			return handleCommandExecuted(props);

		// VCS events
		case 'vcs.branch.updated':
			return handleVcsBranchUpdated(props, sessionId);

		// MCP events
		case 'mcp.tools.changed':
			return handleMcpToolsChanged(props, sessionId);

		// LSP events
		case 'lsp.updated':
			return handleLspUpdated(props, sessionId);

		case 'lsp.client.diagnostics':
			return handleLspDiagnostics(props, sessionId);

		// Installation events
		case 'installation.updated':
			return handleInstallationUpdated(props, sessionId);

		case 'installation.update-available':
			return handleUpdateAvailable(props, sessionId);

		// Project events
		case 'project.updated':
			return handleProjectUpdated(props, sessionId);

		// Server events
		case 'server.instance.disposed':
			return handleServerInstanceDisposed(props, sessionId);

		case 'server.connected':
			return handleServerConnected(props, sessionId);

		case 'global.disposed':
			return handleGlobalDisposed(props, sessionId);

		// PTY events (terminal)
		case 'pty.created':
		case 'pty.updated':
		case 'pty.exited':
		case 'pty.deleted':
			return handlePtyEvent(typed.type, props, sessionId);

		// TUI events (not typically needed in VS Code extension, but handle gracefully)
		case 'tui.prompt.append':
		case 'tui.command.execute':
		case 'tui.toast.show':
		case 'tui.session.select':
			return null; // TUI events are for terminal UI, not VS Code

		default:
			logger.debug(`[OpenCodeEventParser] Unhandled event type: ${typed.type}`);
			return null;
	}
}

/**
 * Runtime schema for `message.part.updated` event properties.
 * This is a hot path: validating here prevents downstream `as string` crashes.
 */
function handlePartUpdated(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(MessagePartUpdatedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'message.part.updated',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'message.part.updated.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	const typed = props as {
		part: {
			id: string;
			type: string;
			messageID: string;
			text?: string;
			tool?: string;
			state?: ToolState;
			callID?: string;
			cost?: number;
			tokens?: {
				input: number;
				output: number;
				reasoning: number;
				cache: { read: number; write: number };
			};
			prompt?: string;
			description?: string;
			agent?: string;
			command?: string;
		};
		delta?: string;
	};

	const part = typed.part;
	const delta = typed.delta;

	// NOTE: We intentionally do NOT handle part.type === 'subtask' separately here.
	// Subtask lifecycle is managed via the 'task' tool (ToolPart with tool='task'),
	// which provides status (pending/running/completed/error) for proper UI tracking.
	// The SubtaskPart is just an input marker and doesn't have status information.

	return {
		type: 'part-update',
		sessionId,
		part: {
			id: part.id,
			type: mapPartType(part.type),
			text: part.text,
			tool: part.tool,
			state: part.state,
			messageID: part.messageID,
			callID: part.callID,
			cost: part.cost,
			tokens: part.tokens,
			// Subtask fields (for SubtaskPart, though we don't create separate subtask events)
			prompt: part.prompt,
			description: part.description,
			agent: part.agent,
			command: part.command,
		},
		// Include delta for streaming text updates
		streamEvent: delta
			? {
					uuid: part.id,
					event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } },
				}
			: undefined,
	};
}

function handlePartRemoved(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const partSessionId = (props.sessionID as string) || sessionId;
	const messageID = props.messageID as string;
	const partID = props.partID as string;

	logger.debug(`[OpenCodeEventParser] Part removed: ${partID} from message ${messageID}`);
	return {
		type: 'stream_event',
		subtype: 'message.part.removed',
		sessionId: partSessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ messageID, partID }) }] },
	};
}

function handleMessageUpdated(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(MessageUpdatedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'message.updated',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'message.updated.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	const typed = props as {
		info: {
			id: string;
			role: 'user' | 'assistant';
			parts?: MessagePart[];
			tokens?: {
				input?: number;
				output?: number;
				reasoning?: number;
				cache?: { read?: number; write?: number };
			};
			time?: { created?: number; completed?: number };
		};
	};

	const info = typed.info;
	const sdkTokens = info.tokens;

	const usage = sdkTokens
		? {
				input_tokens: sdkTokens.input ?? 0,
				output_tokens: sdkTokens.output ?? 0,
				cache_read_input_tokens: sdkTokens.cache?.read ?? 0,
				cache_creation_input_tokens: sdkTokens.cache?.write ?? 0,
				reasoning_tokens: sdkTokens.reasoning ?? 0,
			}
		: undefined;

	// OpenCode provides per-message timestamps (ms). Normalize to CLIStreamData.durationMs so
	// StreamHandler can aggregate totalDuration consistently across providers.
	const durationMs =
		info.time?.created && info.time?.completed
			? Math.max(0, info.time.completed - info.time.created)
			: undefined;

	return {
		type: 'message-update',
		sessionId,
		durationMs,
		fullMessage: {
			id: info.id,
			role: info.role,
			parts: info.parts,
		},
		message: { content: [], usage },
	};
}

function handleMessageRemoved(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const msgSessionId = (props.sessionID as string) || sessionId;
	const messageID = props.messageID as string;

	logger.debug(`[OpenCodeEventParser] Message removed: ${messageID}`);
	return {
		type: 'stream_event',
		subtype: 'message.removed',
		sessionId: msgSessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ messageID }) }] },
	};
}

/**
 * Handle permission.asked event (SDK v2).
 * Maps PermissionRequest structure to our permission-required format.
 */
function handlePermissionAsked(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(PermissionAskedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'permission.asked',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'permission.asked.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	// SDK v2 PermissionRequest structure:
	// { id, sessionID, permission, patterns, metadata, always, tool?: { messageID, callID } }
	const typed = props as {
		id: string;
		sessionID?: string;
		permission: string;
		patterns?: string[];
		metadata?: Record<string, unknown>;
		tool?: { messageID: string; callID?: string };
	};

	const id = typed.id;
	const permSessionId = typed.sessionID || sessionId;
	const permission = typed.permission;
	const patterns = typed.patterns;
	const metadata = typed.metadata ?? {};
	const tool = typed.tool;

	return {
		type: 'permission-required',
		sessionId: permSessionId,
		permission: {
			id,
			type: permission,
			pattern: patterns,
			sessionID: permSessionId,
			messageID: tool?.messageID || '',
			callID: tool?.callID,
			title: permission || 'Permission Required',
			metadata,
			time: { created: Date.now() },
		},
	};
}

/**
 * Handle permission.replied event - confirmation that permission was processed
 */
function handlePermissionReplied(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const permSessionId = (props.sessionID as string) || sessionId;
	const requestID = props.requestID as string;
	const reply = props.reply as 'once' | 'always' | 'reject';

	logger.debug(`[OpenCodeEventParser] Permission replied: ${requestID} -> ${reply}`);
	return {
		type: 'stream_event',
		subtype: 'permission.replied',
		sessionId: permSessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ requestID, reply }) }] },
	};
}

function handleSessionUpdated(props: Record<string, unknown>): CLIStreamData {
	const session = props.info as OpenCodeSession;
	return {
		type: 'session-updated',
		sessionId: session.id,
		sessionTitle: session.title,
	};
}

function handleSessionError(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(SessionErrorSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'session.error',
			sessionId,
			level: 'error',
		})
	) {
		return {
			type: 'error',
			sessionId,
			isError: true,
			message: { content: [{ type: 'text', text: 'Error: Invalid session.error payload' }] },
		};
	}

	logger.error('[OpenCodeEventParser] Session error event:', JSON.stringify(props));

	const typed = props as {
		error?:
			| {
					name?: string;
					message?: string;
					data?: { message?: string; statusCode?: number };
			  }
			| string;
		message?: string;
	};

	const errorObj = typed.error;

	let errorMessage = 'Unknown error occurred';
	if (typeof errorObj === 'string') {
		errorMessage = errorObj;
	} else if (errorObj) {
		errorMessage = errorObj.data?.message || errorObj.message || errorObj.name || errorMessage;
		if (errorObj.data?.statusCode) {
			errorMessage = `[${errorObj.data.statusCode}] ${errorMessage}`;
		}
	} else if (typed.message) {
		errorMessage = typed.message;
	}

	logger.error(`[OpenCodeEventParser] Session error: ${errorMessage}`);
	return {
		type: 'error',
		sessionId,
		isError: true,
		message: { content: [{ type: 'text', text: `Error: ${errorMessage}` }] },
	};
}

// =========================================================================
// Additional Event Handlers
// =========================================================================

function handleTodoUpdated(props: Record<string, unknown>): CLIStreamData {
	const todos = props.todos as Array<{
		id: string;
		content: string;
		status: string;
		priority: string;
	}>;
	const todoSessionId = props.sessionID as string;
	logger.debug(`[OpenCodeEventParser] Todo updated for session ${todoSessionId}:`, todos?.length);
	return {
		type: 'stream_event',
		subtype: 'todo.updated',
		sessionId: todoSessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ todos }) }] },
	};
}

function handleSessionStatus(props: Record<string, unknown>): CLIStreamData {
	const statusSessionId = props.sessionID as string;
	const status = props.status as {
		type: string;
		attempt?: number;
		message?: string;
		next?: number;
	};
	logger.debug(`[OpenCodeEventParser] Session status: ${statusSessionId} -> ${status?.type}`);
	return {
		type: 'stream_event',
		subtype: 'session.status',
		sessionId: statusSessionId,
		sessionStatus: status?.type as 'idle' | 'busy' | 'retry',
		message: { content: [{ type: 'text', text: JSON.stringify({ status }) }] },
	};
}

function handleSessionCompacted(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const compactedSessionId = (props.sessionID as string) || sessionId;
	logger.info(`[OpenCodeEventParser] Session compacted: ${compactedSessionId}`);
	return {
		type: 'stream_event',
		subtype: 'session.compacted',
		sessionId: compactedSessionId,
		message: { content: [{ type: 'text', text: 'Session context was compacted' }] },
	};
}

function handleFileEdited(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(FileEditedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'file.edited',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'file.edited.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	const typed = props as { file: string };
	const filePath = typed.file;
	logger.debug(`[OpenCodeEventParser] File edited: ${filePath}`);
	return {
		type: 'stream_event',
		subtype: 'file.edited',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ file: filePath }) }] },
	};
}

function handleCommandExecuted(props: Record<string, unknown>): CLIStreamData {
	if (
		!validateOrLog(CommandExecutedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'command.executed',
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'command.executed.invalid',
			sessionId: '',
			message: { content: [] },
		};
	}

	const typed = props as { name: string; arguments?: string; sessionID?: string };
	const commandName = typed.name;
	const commandArgs = typed.arguments ?? '';
	const commandSessionId = typed.sessionID ?? '';
	logger.debug(
		`[OpenCodeEventParser] Command executed: ${commandName} in session ${commandSessionId}`,
	);
	return {
		type: 'stream_event',
		subtype: 'command.executed',
		sessionId: commandSessionId,
		message: {
			content: [
				{ type: 'text', text: JSON.stringify({ command: commandName, arguments: commandArgs }) },
			],
		},
	};
}

function handleVcsBranchUpdated(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const branch = props.branch as string | undefined;
	logger.debug(`[OpenCodeEventParser] VCS branch updated: ${branch}`);
	return {
		type: 'stream_event',
		subtype: 'vcs.branch.updated',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ branch }) }] },
	};
}

function handleMcpToolsChanged(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const server = props.server as string;
	logger.debug(`[OpenCodeEventParser] MCP tools changed for server: ${server}`);
	return {
		type: 'stream_event',
		subtype: 'mcp.tools.changed',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ server }) }] },
	};
}

function handleFileWatcherUpdated(
	props: Record<string, unknown>,
	sessionId: string,
): CLIStreamData {
	if (
		!validateOrLog(FileWatcherUpdatedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'file.watcher.updated',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'file.watcher.updated.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	const typed = props as { file: string; event: 'add' | 'change' | 'unlink' };
	const watchedFile = typed.file;
	const watchEvent = typed.event;
	logger.debug(`[OpenCodeEventParser] File watcher: ${watchEvent} ${watchedFile}`);
	return {
		type: 'stream_event',
		subtype: 'file.watcher.updated',
		sessionId,
		message: {
			content: [{ type: 'text', text: JSON.stringify({ file: watchedFile, event: watchEvent }) }],
		},
	};
}

function handleSessionCreated(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(SessionCreatedSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'session.created',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'session.created.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	const typed = props as { info: OpenCodeSession & { parentID?: string } };
	const createdSession = typed.info;
	logger.debug(`[OpenCodeEventParser] Session created: ${createdSession?.id}`);

	if (createdSession.parentID) {
		// This is a child session for a subtask
		return {
			type: 'child-session-created',
			sessionId: createdSession.parentID, // Parent session
			childSession: {
				id: createdSession.id,
				title: createdSession.title,
				parentID: createdSession.parentID,
			},
		};
	}

	return {
		type: 'stream_event',
		subtype: 'session.created',
		sessionId: createdSession?.id || sessionId,
		sessionTitle: createdSession?.title,
		message: { content: [{ type: 'text', text: 'New session created' }] },
	};
}

function handleSessionDeleted(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const deletedSession = props.info as OpenCodeSession;
	logger.debug(`[OpenCodeEventParser] Session deleted: ${deletedSession?.id}`);
	return {
		type: 'stream_event',
		subtype: 'session.deleted',
		sessionId: deletedSession?.id || sessionId,
		message: { content: [{ type: 'text', text: 'Session deleted' }] },
	};
}

function handleSessionIdle(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const idleSessionId = (props.sessionID as string) || sessionId;

	// Check if this is a child session
	// If so, mark the parent subtask as completed
	return {
		type: 'session-idle',
		sessionId: idleSessionId,
		// UI will check if this sessionId is a child session and complete the subtask
	};
}

function handleSessionDiff(props: Record<string, unknown>): CLIStreamData {
	if (
		!validateOrLog(SessionDiffSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'session.diff',
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'session.diff.invalid',
			sessionId: '',
			message: { content: [] },
		};
	}

	const typed = props as {
		sessionID: string;
		diff: Array<{
			file: string;
			before: string;
			after: string;
			additions: number;
			deletions: number;
		}>;
	};
	const diffSessionId = typed.sessionID;
	const diffs = typed.diff;
	logger.debug(
		`[OpenCodeEventParser] Session diff updated: ${diffSessionId}, ${diffs?.length} files`,
	);
	return {
		type: 'stream_event',
		subtype: 'session.diff',
		sessionId: diffSessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ diffs }) }] },
	};
}

function handleInstallationUpdated(
	props: Record<string, unknown>,
	sessionId: string,
): CLIStreamData {
	const version = props.version as string;
	logger.info(`[OpenCodeEventParser] Installation updated to version: ${version}`);
	return {
		type: 'stream_event',
		subtype: 'installation.updated',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ version }) }] },
	};
}

function handleUpdateAvailable(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	const newVersion = props.version as string;
	logger.info(`[OpenCodeEventParser] Update available: ${newVersion}`);
	return {
		type: 'stream_event',
		subtype: 'installation.update-available',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ version: newVersion }) }] },
	};
}

// =========================================================================
// Project & Server Event Handlers
// =========================================================================

function handleProjectUpdated(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	// Project type: { id, worktree, vcs?, name?, icon?, time, sandboxes }
	const project = props as Record<string, unknown>;
	logger.debug(`[OpenCodeEventParser] Project updated: ${project.id}`);
	return {
		type: 'stream_event',
		subtype: 'project.updated',
		sessionId,
		message: {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						id: project.id,
						name: project.name,
						worktree: project.worktree,
					}),
				},
			],
		},
	};
}

function handleServerInstanceDisposed(
	props: Record<string, unknown>,
	sessionId: string,
): CLIStreamData {
	const directory = props.directory as string;
	logger.info(`[OpenCodeEventParser] Server instance disposed for directory: ${directory}`);
	return {
		type: 'stream_event',
		subtype: 'server.instance.disposed',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ directory }) }] },
	};
}

function handleServerConnected(_props: Record<string, unknown>, sessionId: string): CLIStreamData {
	logger.info('[OpenCodeEventParser] Server connected');
	return {
		type: 'stream_event',
		subtype: 'server.connected',
		sessionId,
		message: { content: [{ type: 'text', text: 'Server connected' }] },
	};
}

function handleGlobalDisposed(_props: Record<string, unknown>, sessionId: string): CLIStreamData {
	logger.info('[OpenCodeEventParser] Global disposed');
	return {
		type: 'stream_event',
		subtype: 'global.disposed',
		sessionId,
		message: { content: [{ type: 'text', text: 'Global disposed' }] },
	};
}

// =========================================================================
// LSP Event Handlers
// =========================================================================

function handleLspUpdated(_props: Record<string, unknown>, sessionId: string): CLIStreamData {
	logger.debug('[OpenCodeEventParser] LSP status updated');
	return {
		type: 'stream_event',
		subtype: 'lsp.updated',
		sessionId,
		message: { content: [{ type: 'text', text: 'LSP status updated' }] },
	};
}

function handleLspDiagnostics(props: Record<string, unknown>, sessionId: string): CLIStreamData {
	if (
		!validateOrLog(LspClientDiagnosticsSchema, props, {
			component: 'OpenCodeEventParser',
			label: 'lsp.client.diagnostics',
			sessionId,
			level: 'warn',
		})
	) {
		return {
			type: 'stream_event',
			subtype: 'lsp.client.diagnostics.invalid',
			sessionId,
			message: { content: [] },
		};
	}

	const typed = props as { serverID: string; path: string };
	const serverID = typed.serverID;
	const path = typed.path;
	logger.debug(`[OpenCodeEventParser] LSP diagnostics: ${serverID} - ${path}`);
	return {
		type: 'stream_event',
		subtype: 'lsp.client.diagnostics',
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify({ serverID, path }) }] },
	};
}

// =========================================================================
// PTY (Terminal) Event Handlers
// =========================================================================

function handlePtyEvent(
	eventType: string,
	props: Record<string, unknown>,
	sessionId: string,
): CLIStreamData {
	// PTY events: pty.created, pty.updated, pty.exited, pty.deleted
	// Props contain either 'info' (Pty object) or 'id' + optional 'exitCode'
	const info = props.info as Record<string, unknown> | undefined;
	const id = (info?.id as string) || (props.id as string);

	logger.debug(`[OpenCodeEventParser] PTY event: ${eventType} - ${id}`);

	const payload: Record<string, unknown> = { id };
	if (info) {
		payload.title = info.title;
		payload.command = info.command;
		payload.status = info.status;
		payload.pid = info.pid;
	}
	if (props.exitCode !== undefined) {
		payload.exitCode = props.exitCode;
	}

	return {
		type: 'stream_event',
		subtype: eventType,
		sessionId,
		message: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
	};
}

// =========================================================================
// Utilities
// =========================================================================

function mapPartType(type: string): PartType {
	const map: Record<string, PartType> = {
		'tool-invocation': 'tool',
	};
	return map[type] || (type as PartType);
}
