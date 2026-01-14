/**
 * @file useExtensionMessages - hook for handling VS Code extension messages
 * @description Centralizes all message handling logic from the VS Code extension.
 *              Processes incoming messages and dispatches actions to appropriate Zustand stores.
 *              Handlers are organized by category for maintainability and reduced cognitive complexity.
 */

import { useEffect } from 'react';
import {
	type Access,
	type ExtensionMessage,
	isSessionSpecificMessage,
	type ParsedCommand,
	type SubtaskExtensionMessage,
	type WorkspaceFile,
} from '../../types';
import { FILE_EDIT_TOOLS, isToolInList } from '../constants';
import { type Message, useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { vscode } from '../utils/vscode';

// =============================================================================
// Types
// =============================================================================

type ChatActions = ReturnType<typeof useChatStore.getState>['actions'];
type UIActions = ReturnType<typeof useUIStore.getState>['actions'];
type SettingsActions = ReturnType<typeof useSettingsStore.getState>['actions'];

interface HandlerContext {
	chatActions: ChatActions;
	uiActions: UIActions;
	settingsActions: SettingsActions;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if message is for the active session
 * Messages without sessionId are treated as global (apply to active session)
 */
const isMessageForActiveSession = (message: ExtensionMessage): boolean => {
	if (!message.sessionId) {
		return true;
	}
	const activeSessionId = useChatStore.getState().activeSessionId;
	return message.sessionId === activeSessionId;
};

// =============================================================================
// Session & Lifecycle Handlers
// =============================================================================

const handleSessionMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions, uiActions } = ctx;

	switch (message.type) {
		case 'ready':
			chatActions.setLoading(false);
			chatActions.setStatus('Ready');
			chatActions.setProcessing(false);
			chatActions.setStreamingToolId(null);
			if (message.data) {
				const messages = useChatStore.getState().messages;
				const hasWelcome = messages.some(m => m.type === 'assistant' && m.content === message.data);
				if (!hasWelcome) {
					chatActions.addMessage({
						type: 'assistant',
						content: message.data,
						timestamp: new Date().toISOString(),
					});
				}
			}
			return true;

		case 'loading':
			chatActions.setLoading(true);
			if (message.data) {
				chatActions.setStatus(message.data);
			}
			return true;

		case 'clearLoading':
			chatActions.setLoading(false);
			chatActions.setStatus('Ready');
			return true;

		case 'setProcessing':
			chatActions.setProcessing(message.data?.isProcessing ?? false);
			if (!message.data?.isProcessing) {
				chatActions.setStreamingToolId(null);
			}
			return true;

		case 'sessionRetrying':
			// OpenCode SDK is auto-retrying after an error
			if (message.data) {
				const { attempt, message: retryMessage, nextRetryAt } = message.data;
				chatActions.setAutoRetrying(true, {
					attempt: attempt ?? 1,
					message: retryMessage ?? 'Retrying request...',
					nextRetryAt,
				});
			}
			return true;

		case 'sessionIdle': {
			// Session is idle - clear retry state and stop processing
			chatActions.setAutoRetrying(false);
			chatActions.setProcessing(false);
			chatActions.setStreamingToolId(null);

			// If this is a child session of a running subtask, mark that specific subtask as completed.
			if (message.data?.sessionId) {
				const idleSessionId = message.data.sessionId;
				const state = useChatStore.getState();
				for (const session of state.sessions) {
					for (const msg of session.messages) {
						if (msg.type !== 'subtask') {
							continue;
						}
						if (msg.childSessionId !== idleSessionId) {
							continue;
						}
						if (msg.status !== 'running') {
							continue;
						}

						if (!msg.id) {
							continue;
						}
						chatActions.completeSubtask(msg.id);
					}
				}
			}
			return true;
		}

		case 'sessionCreated':
			if (message.data?.sessionId) {
				const newSessionId = message.data.sessionId;
				// Create session in store but don't auto-switch (parallel sessions support)
				chatActions.handleSessionCreated(newSessionId);
				// Only switch if this is the first session (no active session yet)
				const state = useChatStore.getState();
				if (!state.activeSessionId) {
					chatActions.switchSession(newSessionId);
				}
			}
			return true;

		case 'child-session-created': {
			if (message.data) {
				const { id: childSessionId } = message.data;
				const state = useChatStore.getState();
				// parentID is CLI session ID, not UI session ID
				// Use active session instead since events are routed to active session
				const activeSessionId = state.activeSessionId;
				const parentSession = state.sessions.find(s => s.id === activeSessionId);

				console.log(
					`[useExtensionMessages] child-session-created: childSessionId=${childSessionId}, activeSessionId=${activeSessionId}`,
				);

				if (parentSession) {
					// OpenCode can create multiple child sessions concurrently (multi-subtasks).
					// We link deterministically by picking the oldest running subtask without a childSessionId.
					const candidateSubtasks = parentSession.messages
						.filter(
							(m): m is Message & { type: 'subtask'; status: string; childSessionId?: string } =>
								m.type === 'subtask' &&
								(m as { status?: string }).status === 'running' &&
								(!(m as { childSessionId?: string }).childSessionId ||
									(m as { childSessionId?: string }).childSessionId?.length === 0),
						)
						.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

					console.log(
						`[useExtensionMessages] Found ${candidateSubtasks.length} candidate subtasks:`,
						candidateSubtasks.map(s => ({ id: s.id, status: s.status })),
					);

					const subtaskToLink = candidateSubtasks[0];
					if (subtaskToLink?.id) {
						console.log(
							`[useExtensionMessages] Linking childSessionId ${childSessionId} to subtask ${subtaskToLink.id}`,
						);
						chatActions.linkChildSessionToSubtask(childSessionId, subtaskToLink.id);
					}
				} else {
					console.warn(
						`[useExtensionMessages] No parent session found for activeSessionId=${activeSessionId}`,
					);
				}
			}
			return true;
		}

		case 'sessionSwitched':
			if (message.data) {
				const { sessionId, isProcessing, totalStats } = message.data;
				// First switch session (this updates activeSessionId and loads empty/stale messages)
				chatActions.switchSession(sessionId);

				// Then update processing/stats if provided
				if (isProcessing !== undefined) {
					chatActions.setProcessing(isProcessing);
				}
				if (totalStats) {
					chatActions.setTotalStats(totalStats);
				}
			}
			return true;

		case 'sessionClosed':
			if (message.data?.sessionId) {
				chatActions.closeSession(message.data.sessionId);
			}
			return true;

		case 'sessionCleared':
			chatActions.clearMessages();
			chatActions.setProcessing(false);
			chatActions.setStreamingToolId(null);
			return true;

		case 'sessionProcessingComplete':
			if (message.data) {
				const { sessionId: _sessionId, stats } = message.data;
				chatActions.setTotalStats(stats);
				chatActions.setProcessing(false);
				chatActions.setStreamingToolId(null);
			}
			return true;

		case 'workspaceInfo':
			if (message.data?.name) {
				uiActions.setWorkspaceName(message.data.name);
			}
			return true;

		case 'sessionInfo':
			if (message.data) {
				const { sessionId, tools, mcpServers } = message.data;
				uiActions.setSessionInfo({
					sessionId,
					tools: tools || [],
					mcpServers: mcpServers || [],
				});
			}
			return true;

		case 'projectUpdated':
			if (message.data?.project) {
				const { name } = message.data.project;
				if (name) {
					uiActions.setWorkspaceName(name);
					// Silent operation
				}
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Chat Message Handlers
// =============================================================================

const handleChatMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions } = ctx;

	switch (message.type) {
		case 'userInput':
		case 'user': {
			const data = message.data;
			type UserInputData = { text?: string; messageId?: string; model?: string };
			const msgInput =
				message.type === 'user'
					? (message as unknown as Message)
					: {
							type: 'user' as const,
							content:
								(typeof data === 'string' ? data : (data as UserInputData | undefined)?.text) || '',
							id: (data as UserInputData | undefined)?.messageId,
							model: (data as UserInputData | undefined)?.model,
							timestamp: new Date().toISOString(),
						};
			chatActions.addMessage(msgInput);
			return true;
		}

		case 'output':
		case 'assistant': {
			const msg = message as unknown as {
				content?: string;
				data?: string;
				id?: string;
				partId?: string;
				childSessionId?: string;
				hidden?: boolean;
			};
			const content =
				message.type === 'assistant' ? (msg.content ?? '') : (msg.data as string) || '';

			// If from child session, add to child session instead of main
			if (msg.childSessionId) {
				chatActions.addMessageToSession(msg.childSessionId, {
					type: 'assistant',
					content,
					id: msg.id ?? msg.partId,
					partId: msg.partId,
					timestamp: new Date().toISOString(),
				});
				return true;
			}

			// Otherwise add to current session
			chatActions.addMessage({
				type: 'assistant',
				content,
				id: msg.id ?? msg.partId,
				partId: msg.partId,
				timestamp: new Date().toISOString(),
			});
			return true;
		}

		case 'system_notice': {
			type SystemNoticePayload = {
				id?: string;
				timestamp?: string;
				content?: string;
			};
			const msg = message as unknown as SystemNoticePayload;
			chatActions.addMessage({
				type: 'system_notice',
				content: msg.content || 'Summarizing context',
				id: msg.id,
				timestamp: msg.timestamp ?? new Date().toISOString(),
			});
			return true;
		}

		case 'thinking': {
			type ThinkingPayload = {
				id?: string;
				partId?: string;
				content?: string;
				data?: string;
				durationMs?: number;
				reasoningTokens?: number;
				isStreaming?: boolean;
				isDelta?: boolean;
				startTime?: number;
				parentToolUseId?: string;
			};
			const msg = message as unknown as ThinkingPayload;
			const content = msg.content ?? msg.data;

			chatActions.addMessage({
				type: 'thinking',
				content: content || '',
				// Prefer extension-provided id; fallback to partId for streaming identity.
				id: msg.id ?? msg.partId,
				partId: msg.partId,
				durationMs: msg.durationMs,
				reasoningTokens: msg.reasoningTokens,
				isStreaming: msg.isStreaming,
				isDelta: msg.isDelta,
				startTime: msg.startTime,
				timestamp: new Date().toISOString(),
				hidden: !!msg.parentToolUseId,
			});

			if (msg.parentToolUseId && msg.id) {
				chatActions.addChildToSubtask(msg.parentToolUseId, msg.id);
			}
			return true;
		}

		case 'subtask': {
			const subtask = message as SubtaskExtensionMessage;
			if (subtask.status === 'completed') {
				chatActions.completeSubtask(subtask.id, subtask.result);
			} else if (subtask.status === 'error') {
				chatActions.errorSubtask(subtask.id, subtask.result || 'Unknown error');
			} else {
				chatActions.startSubtask({
					type: 'subtask',
					id: subtask.id,
					timestamp: subtask.timestamp || new Date().toISOString(),
					agent: subtask.agent,
					prompt: subtask.prompt,
					description: subtask.description,
					command: subtask.command,
					status: subtask.status,
					messageID: subtask.messageID,
				});
			}
			return true;
		}

		case 'error': {
			type ErrorPayload = { id?: string; timestamp?: string; content?: string };
			const topLevel = message as unknown as ErrorPayload;
			const fromData =
				message.data && typeof message.data === 'object'
					? (message.data as ErrorPayload)
					: undefined;
			const content = topLevel.content ?? fromData?.content;

			chatActions.addMessage({
				type: 'error',
				content: content || 'Unknown error',
				id: topLevel.id ?? fromData?.id,
				timestamp: topLevel.timestamp ?? fromData?.timestamp ?? new Date().toISOString(),
			});
			chatActions.setProcessing(false);
			chatActions.setStreamingToolId(null);
			return true;
		}

		case 'interrupted': {
			type InterruptedPayload = {
				id?: string;
				timestamp?: string;
				content?: string;
				reason?: string;
			};
			const data =
				message.data && typeof message.data === 'object'
					? (message.data as InterruptedPayload)
					: undefined;

			chatActions.addMessage({
				type: 'interrupted',
				content: data?.content ?? 'Processing was interrupted',
				reason: data?.reason,
				id: data?.id,
				timestamp: data?.timestamp ?? new Date().toISOString(),
			});
			chatActions.setProcessing(false);
			chatActions.setStreamingToolId(null);
			return true;
		}

		case 'messagePartRemoved': {
			const data = message.data as { messageId: string; partId: string } | undefined;
			if (data?.partId) {
				chatActions.removeMessageByPartId(data.partId);
			}
			return true;
		}

		default:
			return false;
	}
};

// =============================================================================
// Tool Handlers
// =============================================================================

const handleToolMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions } = ctx;

	switch (message.type) {
		case 'toolUse':
		case 'tool_use': {
			type ToolUseData = {
				toolName: string;
				toolUseId: string;
				toolInput?: string;
				rawInput?: Record<string, unknown>;
				filePath?: string;
				streamingOutput?: string;
				isRunning?: boolean;
				metadata?: Record<string, unknown>;
				parentToolUseId?: string;
				childSessionId?: string;
				hidden?: boolean;
			};
			const data = (message.type === 'tool_use' ? message : message.data) as ToolUseData;

			if (!data?.toolName) {
				console.warn('[useExtensionMessages] tool_use message missing toolName:', message);
				return true;
			}

			// If from child session, add to child session instead of main
			if (data.childSessionId) {
				chatActions.addMessageToSession(data.childSessionId, {
					type: 'tool_use',
					toolName: data.toolName,
					toolUseId: data.toolUseId,
					id: data.toolUseId,
					toolInput: data.toolInput,
					rawInput: data.rawInput,
					filePath: data.filePath || undefined,
					streamingOutput: data.streamingOutput,
					isRunning: data.isRunning,
					metadata: data.metadata,
					timestamp: new Date().toISOString(),
				});
				return true;
			}

			// Otherwise add to current session
			const shouldHide = !!data.parentToolUseId;

			chatActions.addMessage({
				type: 'tool_use',
				toolName: data.toolName,
				toolUseId: data.toolUseId,
				id: data.toolUseId,
				toolInput: data.toolInput,
				rawInput: data.rawInput,
				filePath: data.filePath || undefined,
				streamingOutput: data.streamingOutput,
				isRunning: data.isRunning,
				metadata: data.metadata,
				timestamp: new Date().toISOString(),
				hidden: shouldHide,
			});

			// If it's a child tool call (subtask), link it to the parent
			if (data.parentToolUseId) {
				chatActions.addChildToSubtask(data.parentToolUseId, data.toolUseId);
			}

			if (isToolInList(data.toolName, FILE_EDIT_TOOLS) || data.toolName === 'TodoWrite') {
				if (
					data.isRunning ||
					(typeof data.streamingOutput === 'string' && data.streamingOutput.length > 0)
				) {
					chatActions.setStreamingToolId(data.toolUseId);
				}
			}
			return true;
		}

		case 'toolResult':
		case 'tool_result': {
			type ToolResultData = {
				toolName: string;
				toolUseId: string;
				content: string;
				isError: boolean;
				estimatedTokens?: number;
				hidden?: boolean;
				title?: string;
				durationMs?: number;
				attachments?: Array<{
					id: string;
					mime: string;
					filename?: string;
					url: string;
				}>;
				metadata?: Record<string, unknown>;
				parentToolUseId?: string;
				childSessionId?: string;
			};
			const data = (message.type === 'tool_result' ? message : message.data) as ToolResultData;

			// If from child session, add to child session instead of main
			if (data.childSessionId) {
				chatActions.addMessageToSession(data.childSessionId, {
					type: 'tool_result',
					toolName: data.toolName,
					toolUseId: data.toolUseId,
					id: data.toolUseId ? `${data.toolUseId}:result` : undefined,
					content: data.content,
					isError: data.isError,
					timestamp: new Date().toISOString(),
					estimatedTokens:
						data.estimatedTokens ?? (data.content ? Math.ceil(data.content.length / 4) : 0),
					title: data.title,
					durationMs: data.durationMs,
					attachments: data.attachments,
					metadata: data.metadata,
				});
				chatActions.setStreamingToolId(null);
				return true;
			}

			// Otherwise add to current session
			const shouldHide = !!data.parentToolUseId;

			chatActions.addMessage({
				type: 'tool_result',
				toolName: data.toolName,
				toolUseId: data.toolUseId,
				id: data.toolUseId ? `${data.toolUseId}:result` : undefined,
				content: data.content,
				isError: data.isError,
				timestamp: new Date().toISOString(),
				estimatedTokens:
					data.estimatedTokens ?? (data.content ? Math.ceil(data.content.length / 4) : 0),
				hidden: shouldHide,
				title: data.title,
				durationMs: data.durationMs,
				attachments: data.attachments,
				metadata: data.metadata,
			});
			chatActions.setStreamingToolId(null);

			// If it's a child tool call (subtask), link it to the parent
			if (data.parentToolUseId) {
				chatActions.addChildToSubtask(data.parentToolUseId, data.toolUseId);
			}
			return true;
		}

		default:
			return false;
	}
};

// =============================================================================
// Access Handlers
// =============================================================================

const handleAccessMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions, settingsActions } = ctx;

	switch (message.type) {
		case 'accessRequest':
		case 'access_request': {
			type AccessRequestData = {
				requestId?: string;
				id?: string;
				tool: string;
				input: Record<string, unknown>;
				pattern?: string;
				timestamp?: number;
				toolUseId?: string;
			};
			const data = (
				message.type === 'access_request' ? message : message.data
			) as AccessRequestData;
			const requestId = data.requestId || data.id || '';
			chatActions.addMessage({
				type: 'access_request',
				requestId,
				// Stable id ensures repeated events update instead of append.
				id: requestId || undefined,
				toolUseId: data.toolUseId,
				tool: data.tool,
				input: data.input,
				pattern: data.pattern,
				timestamp:
					typeof data.timestamp === 'string'
						? data.timestamp
						: new Date(data.timestamp || Date.now()).toISOString(),
			});
			return true;
		}

		case 'accessResponse':
			if (message.data) {
				const { id, approved } = message.data;
				const messages = useChatStore.getState().messages;
				const requestMsg = messages.find(
					m =>
						m.type === 'access_request' &&
						(m as Extract<Message, { type: 'access_request' }>).requestId === id,
				);

				if (requestMsg?.id) {
					chatActions.updateMessage(requestMsg.id, {
						resolved: true,
						approved,
					});
				}
			}
			return true;

		case 'accessData':
			if (message.data) {
				const access = Array.isArray(message.data)
					? (message.data as Access[])
					: [message.data as Access];
				settingsActions.setAccess(access);
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Stats & Tokens Handlers
// =============================================================================

const handleStatsMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions } = ctx;

	switch (message.type) {
		case 'updateTokens':
			if (message.data) {
				chatActions.setTokenStats(message.data);
			}
			return true;

		case 'updateTotals':
			if (message.data) {
				chatActions.setTotalStats(message.data);
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Restore & Revert Handlers
// =============================================================================

const handleRestoreMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions } = ctx;

	switch (message.type) {
		case 'showRestoreOption':
			if (message.data) {
				chatActions.addRestoreCommit(message.data, message.sessionId);
			}
			return true;

		case 'clearRestoreCommits':
			chatActions.clearRestoreCommits(message.sessionId);
			return true;

		case 'updateRestoreCommits':
			chatActions.setRestoreCommits(message.data ?? [], message.sessionId);
			return true;

		case 'restoreInputText':
			if (message.data) {
				chatActions.setInput(message.data);
			}
			return true;

		case 'messagesReloaded':
			if (message.data) {
				const { messages } = message.data as { messages: Message[] };
				const targetSessionId = message.sessionId || useChatStore.getState().activeSessionId;

				console.debug(
					`[ExtensionMessages] Reloading ${messages.length} messages for session: ${targetSessionId}`,
				);

				useChatStore.setState(state => {
					// 1. Update the session in the sessions list
					const sessions = state.sessions.map(s =>
						s.id === targetSessionId ? { ...s, messages, lastActive: Date.now() } : s,
					);

					// 2. If it's the active session, IMMEDIATELY update the active messages array
					// This triggers the React re-render cycle with new messages
					if (targetSessionId === state.activeSessionId) {
						return { messages, sessions };
					}

					return { sessions };
				});
			}
			return true;

		case 'restoreSuccess':
			if (message.data) {
				const { canUnrevert } = message.data as {
					message: string;
					canUnrevert?: boolean;
				};
				// Silent operation
				if (canUnrevert !== undefined) {
					chatActions.setUnrevertAvailable(canUnrevert, message.sessionId);
				}
			}
			return true;

		case 'unrevertAvailable':
			if (message.data) {
				const { available } = message.data as { available?: boolean; sessionId?: string };
				chatActions.setUnrevertAvailable(available !== false, message.sessionId);
				if (available === false && isMessageForActiveSession(message)) {
					chatActions.markRevertedFromMessageId(null);
				}
			}
			return true;

		case 'restoreError':
			return true;

		case 'restoreProgress':
			// Silent operation
			return true;

		case 'deleteMessagesAfter':
			// Cursor-style restore: delete messages after the specified message ID
			// User message stays in place for inline editing
			if (message.data) {
				const { messageId } = message.data as { messageId: string };
				const targetSessionId = message.sessionId || useChatStore.getState().activeSessionId;

				if (messageId) {
					console.debug(
						`[ExtensionMessages] Deleting messages after ${messageId} for session: ${targetSessionId}`,
					);

					useChatStore.setState(state => {
						const idx = state.messages.findIndex(m => m.id === messageId);
						if (idx === -1) {
							return state;
						}

						// Keep messages up to and including the target message
						const newMessages = state.messages.slice(0, idx + 1);

						const sessions = state.sessions.map(s =>
							s.id === targetSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						if (targetSessionId === state.activeSessionId) {
							return { messages: newMessages, sessions };
						}

						return { sessions };
					});
				}
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// File Handlers
// =============================================================================

const handleFileMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { chatActions, uiActions } = ctx;

	switch (message.type) {
		case 'workspaceFiles':
			if (Array.isArray(message.data)) {
				uiActions.setWorkspaceFiles(message.data as WorkspaceFile[]);
			}
			return true;

		case 'fileChanged':
			if (message.data) {
				const {
					filePath,
					changeType: _changeType,
					linesAdded = 0,
					linesRemoved = 0,
					toolUseId = '',
				} = message.data;
				const fileName = filePath.split(/[/\\]/).pop() || filePath;
				chatActions.addChangedFile({
					filePath,
					fileName,
					linesAdded,
					linesRemoved,
					toolUseId,
					timestamp: Date.now(),
				});
				// Silent operation
			}
			return true;

		case 'fileChangeUndone':
			if (message.data?.filePath) {
				chatActions.removeChangedFile(message.data.filePath);
				// Silent operation
			}
			return true;

		case 'allChangesUndone':
			chatActions.clearChangedFiles();
			// Silent operation
			return true;

		case 'imagePath':
			if (message.data?.filePath) {
				const path = message.data.filePath;
				window.dispatchEvent(new CustomEvent('image-captured', { detail: path }));
			}
			return true;

		case 'imageData':
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Settings & Configuration Handlers
// =============================================================================

const handleAgentsListUpdate = (
	data: {
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	},
	settingsActions: HandlerContext['settingsActions'],
) => {
	if (data.meta?.operation && data.meta.message) {
		settingsActions.setAgentsOps({
			lastAction: data.meta.operation,
			status: 'success',
			message: data.meta.message,
		});
		setTimeout(() => {
			settingsActions.setAgentsOps({ status: 'idle' });
		}, 3500);
	}
	if (data.error) {
		settingsActions.setAgentsOps({
			lastAction: 'error',
			status: 'error',
			message: data.error,
		});
		setTimeout(() => {
			settingsActions.setAgentsOps({ status: 'idle' });
		}, 6000);
	}
};

const handleSettingsMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions, uiActions } = ctx;

	switch (message.type) {
		case 'commandsList':
			if (message.data) {
				const { custom, isLoading, error, meta } = message.data as {
					custom: ParsedCommand[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setCommands({ custom, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'skillsList':
			if (message.data) {
				const { skills, isLoading, error, meta } = message.data as {
					skills: import('../../types').ParsedSkill[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setSkills({ items: skills, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'hooksList':
			if (message.data) {
				const { hooks, isLoading, error, meta } = message.data as {
					hooks: import('../../types').ParsedHook[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setHooks({ items: hooks, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'subagentsList':
			if (message.data) {
				const { subagents, isLoading, error, meta } = message.data as {
					subagents: import('../../types').ParsedSubagent[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setSubagents({ items: subagents, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'settingsData':
			if (message.data) {
				const settings = message.data;

				// Map backend settings keys to store keys
				const mappedSettings: Record<string, unknown> = {};

				// Direct mappings
				if (settings.provider !== undefined) {
					mappedSettings.provider = settings.provider;
				}

				// Proxy settings
				if (settings['proxy.baseUrl'] !== undefined) {
					mappedSettings.proxyBaseUrl = settings['proxy.baseUrl'];
				}
				if (settings['proxy.apiKey'] !== undefined) {
					mappedSettings.proxyApiKey = settings['proxy.apiKey'];
				}
				if (settings['proxy.enabledModels'] !== undefined) {
					mappedSettings.enabledProxyModels = settings['proxy.enabledModels'];
				}
				if (settings['proxy.useSingleModel'] !== undefined) {
					mappedSettings.proxyUseSingleModel = settings['proxy.useSingleModel'];
				}
				if (settings['proxy.haikuModel'] !== undefined) {
					mappedSettings.proxyHaikuModel = settings['proxy.haikuModel'];
				}
				if (settings['proxy.sonnetModel'] !== undefined) {
					mappedSettings.proxySonnetModel = settings['proxy.sonnetModel'];
				}
				if (settings['proxy.opusModel'] !== undefined) {
					mappedSettings.proxyOpusModel = settings['proxy.opusModel'];
				}
				if (settings['proxy.subagentModel'] !== undefined) {
					mappedSettings.proxySubagentModel = settings['proxy.subagentModel'];
				}

				// Prompt Improver settings
				if (settings['promptImprove.model'] !== undefined) {
					mappedSettings.promptImproveModel = settings['promptImprove.model'];
				}
				if (settings['promptImprove.template'] !== undefined) {
					mappedSettings.promptImproveTemplate = settings['promptImprove.template'];
				}
				if (settings['promptImprove.timeoutMs'] !== undefined) {
					// Stored in ms in extension settings; displayed as seconds in UI.
					const ms = settings['promptImprove.timeoutMs'];
					mappedSettings.promptImproveTimeoutSeconds =
						typeof ms === 'number' && Number.isFinite(ms) ? Math.max(1, Math.round(ms / 1000)) : 30;
				}

				// OpenCode settings
				if (settings['opencode.agent'] !== undefined) {
					mappedSettings.opencodeAgent = settings['opencode.agent'];
				}
				if (settings['opencode.enabledModels'] !== undefined) {
					mappedSettings.enabledOpenCodeModels = settings['opencode.enabledModels'];
				}

				// Unified provider settings
				if (settings['providers.disabled'] !== undefined) {
					mappedSettings.disabledProviders = settings['providers.disabled'];
				}

				settingsActions.setSettings(mappedSettings);
			}
			return true;

		case 'platformInfo':
			if (message.data) {
				uiActions.setPlatformInfo(message.data);
			}
			return true;

		case 'modelSelected':
			if (message.model) {
				settingsActions.setSelectedModel(message.model);
			}
			return true;

		case 'proxyModels':
			if (message.data) {
				const { models, error, baseUrl } = message.data;
				settingsActions.setProxyModels(models || []);
				// Reset loading state and set success/error status
				settingsActions.setProxyTestStatus({
					isLoading: false,
					success: !error && models && models.length > 0,
					error: error || null,
					lastTested: Date.now(),
				});
				if (error) {
				}
				// Store baseUrl for reference (but don't auto-save to avoid restart loops)
				if (baseUrl) {
					settingsActions.setSettings({ proxyBaseUrl: baseUrl });
				}
				// NOTE: Proxy provider is saved to opencode.json only when user
				// explicitly clicks "Fetch Models" button. The save is triggered
				// by SettingsHandler.loadProxyModels which calls saveProxyProviderForOpenCode
				// after successful model fetch. This prevents restart loops on init.
			}
			return true;

		case 'anthropicModels':
			if (message.data) {
				const { models, error } = message.data;
				settingsActions.setAnthropicModels(models || []);
				settingsActions.setAnthropicModelsStatus({
					isLoading: false,
					success: !error && models && models.length > 0,
					error: error || null,
					lastTested: Date.now(),
				});
				if (typeof message.data.keyPresent === 'boolean') {
					settingsActions.setAnthropicKeyStatus({ hasKey: message.data.keyPresent, error: null });
				}
			}
			return true;

		case 'anthropicKeyStatus':
			if (message.data) {
				const { hasKey, error } = message.data as { hasKey?: boolean; error?: string };
				if (typeof hasKey === 'boolean') {
					settingsActions.setAnthropicKeyStatus({ hasKey, error: error || null });
				}
			}
			return true;

		case 'anthropicKeySaved':
			if (message.data) {
				const { success, error } = message.data as { success?: boolean; error?: string };
				if (!success && error) {
					settingsActions.setAnthropicKeyStatus({ error });
				}
			}
			return true;

		case 'anthropicKeyCleared':
			if (message.data) {
				const { success, error } = message.data as { success?: boolean; error?: string };
				if (success) {
					settingsActions.setAnthropicKeyStatus({ hasKey: false, error: null });
				} else if (error) {
					settingsActions.setAnthropicKeyStatus({ error });
				}
			}
			return true;

		case 'proxyProviderSaving':
			// Optional: show loading state while saving proxy provider
			return true;

		case 'proxyProviderSaved':
			if (message.data) {
				const { success, provider: savedProvider } = message.data;
				if (success) {
					if (savedProvider === 'opencode') {
						console.debug('[ExtensionMessages] Proxy provider saved to opencode.json');
					}
				}
			}
			return true;

		case 'reloadOpenCodeProviders':
			// Trigger reload of OpenCode providers after proxy provider is saved
			vscode.postMessage({ type: 'reloadAllProviders' });
			return true;

		case 'configChanged':
			// Silent operation
			return true;

		case 'clipboardText':
			return true;

		case 'clipboardContext':
			return true;

		case 'clipboardContextNotFound':
			return true;

		case 'cliDiagnostics':
			if (message.data) {
				settingsActions.setCLIDiagnostics(message.data);
			}
			return true;

		case 'discoveryStatus':
			if (message.data) {
				settingsActions.setDiscoveryStatus(message.data);
			}
			return true;

		case 'ruleList':
			if (message.data?.rules) {
				settingsActions.setRules(message.data.rules);
				const meta = (message.data as { meta?: { operation?: string; message?: string } })?.meta;
				if (meta?.operation && meta.message) {
					settingsActions.setAgentsOps({
						lastAction: meta.operation,
						status: 'success',
						message: meta.message,
					});
					setTimeout(() => {
						settingsActions.setAgentsOps({ status: 'idle' });
					}, 3500);
				}
			}
			return true;

		case 'ruleUpdated':
			if (message.data?.rule) {
				settingsActions.updateRule(message.data.rule);
				// Silent operation
			}
			return true;

		case 'permissionsUpdated':
			if (message.data?.policies) {
				settingsActions.setPolicies(message.data.policies);
				// Silent operation
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// OpenCode Provider Handlers
// =============================================================================

const handleOpenCodeMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions } = ctx;

	switch (message.type) {
		case 'openCodeStatus':
			if (message.data) {
				const status = message.data;
				settingsActions.setOpenCodeStatus({
					isChecking: false,
					installed: status.installed,
					version: status.version ?? undefined,
					error: status.error,
				});
			}
			return true;

		case 'openCodeProviders':
			if (message.data) {
				const { providers, config } = message.data;
				settingsActions.setOpenCodeProviders(providers);
				// Reset loading state
				settingsActions.setOpenCodeConfig({ isLoading: false, error: config?.error });
			}
			return true;

		case 'openCodeModelSet':
			if (message.data) {
				const { model } = message.data;
				settingsActions.setSelectedModel(model);
				// Silent operation
			}
			return true;

		case 'openCodeAuthResult':
			if (message.data) {
				const { success, error, providerId, isLoading } = message.data as {
					success?: boolean;
					error?: string;
					providerId?: string;
					isLoading?: boolean;
				};

				// Update provider auth state in settings store
				settingsActions.setProviderAuthState(
					providerId
						? {
								providerId,
								isLoading: isLoading ?? false,
								success: success ?? false,
								error: error ?? undefined,
							}
						: null,
				);

				if (success && !isLoading) {
					// Clear from session disconnected list so it can appear again
					if (providerId) {
						settingsActions.clearSessionDisconnectedProvider(providerId);
					}
					// Silent operation
					vscode.postMessage({ type: 'reloadAllProviders' });
				}
			}
			return true;

		case 'openCodeCustomProviderResult':
			// Silent operation
			return true;

		case 'openCodeDisconnectResult':
			// Silent operation
			return true;

		case 'removeOpenCodeProvider':
			if (message.data) {
				const { providerId, providerName } = message.data as {
					providerId?: string;
					providerName?: string;
				};
				if (providerId) {
					// Get provider info before removing
					const provider = useSettingsStore
						.getState()
						.opencodeProviders.find(p => p.id === providerId);
					// Remove provider from connected list (also cleans enabledOpenCodeModels)
					settingsActions.removeOpenCodeProvider(providerId);
					// Persist enabled model cleanup as well
					const nextEnabled = useSettingsStore
						.getState()
						.enabledOpenCodeModels.filter(id => !id.startsWith(`${providerId}/`));
					settingsActions.setEnabledOpenCodeModels(nextEnabled);
					vscode.postMessage({
						type: 'updateSettings',
						settings: { 'opencode.enabledModels': nextEnabled },
					});
					// Add to available providers list (so user can reconnect)
					if (provider || providerName) {
						settingsActions.addAvailableProvider({
							id: providerId,
							name: provider?.name || providerName || providerId,
							env: [], // Will be populated on next full reload
						});
					}
				}
			}
			return true;

		case 'availableProviders':
			if (message.data) {
				const { providers } = message.data as {
					providers?: Array<{ id: string; name: string; env?: string[] }>;
				};
				if (providers) {
					// Ensure env is always an array (required by AvailableProviderData)
					const normalizedProviders = providers.map(p => ({
						id: p.id,
						name: p.name,
						env: p.env || [],
					}));
					settingsActions.setAvailableProviders(normalizedProviders);
				}
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// MCP & Other Data Handlers
// =============================================================================

const handleDataMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions, uiActions } = ctx;

	switch (message.type) {
		case 'mcpServers':
			if (message.data) {
				const servers = message.data;
				settingsActions.setMcpServers(servers);
			}
			return true;

		case 'mcpInstalledMetadata':
			if (message.data) {
				const data = message.data as {
					metadata?: Record<string, import('../../types').InstalledMcpServerMetadata>;
				};
				settingsActions.setMcpInstalledMetadata(data.metadata ?? {});
			}
			return true;

		case 'mcpMarketplaceCatalog':
			if (message.data) {
				const data = message.data as {
					catalog?: import('../../types').McpMarketplaceCatalog;
					error?: string;
				};
				settingsActions.setMcpMarketplaceState({
					isLoading: false,
					error: data.error ?? null,
					catalog: data.catalog ?? null,
				});
			}
			return true;

		case 'mcpMarketplaceInstallResult':
			if (message.data) {
				const data = message.data as {
					name: string;
					success: boolean;
					error?: string;
					installPrompt?: string;
					githubUrl?: string;
					openedUrl?: string;
				};

				if (data.success && data.installPrompt) {
					// AI-assisted installation: copy prompt to clipboard
					navigator.clipboard.writeText(data.installPrompt).catch(() => {});
				}
				// Silent for other cases (openedUrl, errors, etc.)
			}
			return true;

		case 'mcpServerSaved':
			if (message.data) {
				// Silent operation
				vscode.postMessage({ type: 'loadMCPServers' });
			}
			return true;

		case 'mcpServerDeleted':
			if (message.data) {
				// Silent operation
				vscode.postMessage({ type: 'loadMCPServers' });
			}
			return true;

		case 'mcpServerError':
			// Silent operation
			return true;

		case 'agentsConfigStatus':
			if (message.data) {
				const data = message.data as {
					hasProjectConfig?: boolean;
					projectPath?: string;
				};
				settingsActions.setAgentsConfigStatus({
					hasProjectConfig: data.hasProjectConfig ?? false,
					projectPath: data.projectPath,
				});
			}
			return true;

		case 'opencodeMcpStatus':
			if (message.data) {
				settingsActions.setMcpStatus(
					message.data as Record<string, { status: string; error?: string }>,
				);
			}
			return true;

		case 'mcpStatus':
			if (message.data) {
				settingsActions.setMcpStatus(
					message.data as Record<
						string,
						{
							status: string;
							error?: string;
							tools?: Array<{ name: string; description?: string }>;
							resources?: Array<{ uri: string; name: string; description?: string }>;
						}
					>,
				);
			}
			return true;

		case 'opencodeMcpAuthStarted':
			if (message.data) {
				const { name, authorizationUrl } = message.data as {
					name?: string;
					authorizationUrl?: string;
				};
				if (name && authorizationUrl) {
					// Silent operation (open the URL)
					// Send to extension to open external URL (webview cannot call VS Code API directly)
					vscode.postMessage({ type: 'openExternal', url: authorizationUrl });
					// Refresh MCP status after auth flow
					setTimeout(() => {
						vscode.postMessage({ type: 'loadOpenCodeMcpStatus' });
					}, 2000);
				}
			}
			return true;

		case 'opencodeMcpAuthError':
			// Silent operation
			return true;

		case 'agentsSyncResult':
			if (message.data) {
				const data = message.data as {
					target?: 'claude' | 'opencode' | 'cursor';
					success?: boolean;
					error?: string;
				};

				// Silent operation
				if (!data.success && data.error) {
				}
			}
			return true;

		case 'mcpImportResult':
			if (message.data) {
				const data = message.data as {
					success?: boolean;
					sources?: string[];
					error?: string;
					message?: string;
				};

				// Silent operation
				if (!data.success && data.error) {
				}
			}
			return true;

		case 'conversationList':
			if (Array.isArray(message.data)) {
				uiActions.setConversationList(message.data);
			}
			return true;

		case 'allConversationsCleared':
			useChatStore.setState({
				sessions: [],
				activeSessionId: undefined,
				messages: [],
				isProcessing: false,
				restoreCommits: [],
				changedFiles: [],
			});
			uiActions.setConversationList([]);
			// Silent operation
			return true;

		case 'loginRequired':
			// Silent operation
			return true;

		case 'terminalOpened':
			// Silent operation
			return true;

		case 'improvePromptResult':
			if (message.data) {
				const { improvedText, requestId } = message.data as {
					improvedText: string;
					requestId: string;
				};
				// Verify this is the current request before updating
				const currentReqId = useChatStore.getState().improvingPromptRequestId;
				if (currentReqId === requestId) {
					useChatStore
						.getState()
						.actions.appendInput(`\n\n---\n✨ Enchanted Query:\n${improvedText}`);
					useChatStore.getState().actions.setImprovingPrompt(false, null);
				}
			}
			return true;

		case 'improvePromptError':
			if (message.data) {
				const { requestId } = message.data as { error: string; requestId: string };
				// Verify this is the current request before updating
				const currentReqId = useChatStore.getState().improvingPromptRequestId;
				if (currentReqId === requestId) {
					useChatStore.getState().actions.setImprovingPrompt(false, null);
				}
			}
			return true;

		case 'improvePromptCancelled':
			// Reset state when cancellation is confirmed by backend
			useChatStore.getState().actions.setImprovingPrompt(false, null);
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Main Message Handler
// =============================================================================

const handleExtensionMessage = (message: ExtensionMessage): void => {
	const chatActions = useChatStore.getState().actions;
	const uiActions = useUIStore.getState().actions;
	const settingsActions = useSettingsStore.getState().actions;

	// Filter session-specific messages
	if (isSessionSpecificMessage(message) && !isMessageForActiveSession(message)) {
		const allowBackgroundTypes = new Set([
			'showRestoreOption',
			'clearRestoreCommits',
			'updateRestoreCommits',
			'messagesReloaded',
			'fileChanged',
			'sessionIdle', // Allow background sessions to report idle status (to complete subtasks)
			'child-session-created',
		]);
		if (!allowBackgroundTypes.has(message.type)) {
			return;
		}
	}

	const ctx: HandlerContext = { chatActions, uiActions, settingsActions };

	// Try each handler category in order
	if (handleSessionMessages(message, ctx)) {
		return;
	}
	if (handleChatMessages(message, ctx)) {
		return;
	}
	if (handleToolMessages(message, ctx)) {
		return;
	}
	if (handleAccessMessages(message, ctx)) {
		return;
	}
	if (handleStatsMessages(message, ctx)) {
		return;
	}
	if (handleRestoreMessages(message, ctx)) {
		return;
	}
	if (handleFileMessages(message, ctx)) {
		return;
	}
	if (handleSettingsMessages(message, ctx)) {
		return;
	}
	if (handleOpenCodeMessages(message, ctx)) {
		return;
	}
	if (handleDataMessages(message, ctx)) {
		return;
	}

	// Unknown message type - no action needed
};

// =============================================================================
// Hook Implementation
// =============================================================================

export function useExtensionMessages(): void {
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			handleExtensionMessage(message);
		};

		window.addEventListener('message', handleMessage);

		// Request initial data from extension
		vscode.postMessage({ type: 'webviewDidLaunch' });
		vscode.postMessage({ type: 'getSettings' });
		vscode.postMessage({ type: 'getAccess' });
		vscode.postMessage({ type: 'getCommands' });
		vscode.postMessage({ type: 'getSubagents' });
		vscode.postMessage({ type: 'loadMCPServers' });
		vscode.postMessage({ type: 'fetchMcpMarketplaceCatalog', data: { forceRefresh: false } });
		vscode.postMessage({ type: 'loadOpenCodeMcpStatus' });
		vscode.postMessage({ type: 'loadProxyModels' });
		vscode.postMessage({ type: 'getAnthropicKeyStatus' });
		vscode.postMessage({ type: 'loadAnthropicModels' });
		vscode.postMessage({ type: 'checkOpenCodeStatus' });
		vscode.postMessage({ type: 'reloadAllProviders' });
		vscode.postMessage({ type: 'checkDiscoveryStatus' });
		vscode.postMessage({ type: 'getRules' });

		return () => window.removeEventListener('message', handleMessage);
	}, []);
}
