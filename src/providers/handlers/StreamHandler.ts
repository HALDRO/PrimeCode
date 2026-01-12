/**
 * @file StreamHandler
 * @description Processes CLI stream data from Claude/OpenCode providers. Handles message parsing,
 * token statistics, tool usage tracking, thinking/reasoning output, and error processing.
 */

import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import { errorService, ProcessError } from '../../services/ErrorService';
import type { CLIStreamData } from '../../services/ICLIService';
import type { SessionManager } from '../../services/SessionManager';
import type { TokenUsageAPI } from '../../types';
import { logger } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface StreamHandlerDeps {
	postMessage: (msg: unknown) => void;
	sendAndSaveMessage: (msg: { type: string; [key: string]: unknown }, sessionId?: string) => void;
	createBackup: (message: string, messageId?: string, sessionId?: string) => Promise<void>;
	handleOpenCodeAccess: (data: CLIStreamData) => void;
	handleLoginRequired: (sessionId?: string) => void;
	/** Check if a tool_use has already been created (by AccessHandler for permission) */
	hasToolUseBeenCreated?: (toolUseId: string) => boolean;
	/** Mark a tool_use as created (so AccessHandler doesn't duplicate it) */
	markToolUseCreated?: (toolUseId: string) => void;
}

interface ToolInputWithTodos {
	todos: Array<{
		status: string;
		content: string;
		priority?: string;
	}>;
}

interface ToolUseContent {
	name: string;
	id: string;
	input?: { file_path?: string; todos?: unknown[] };
	parentToolUseId?: string;
}

// =============================================================================
// StreamHandler Class
// =============================================================================

export class StreamHandler {
	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _deps: StreamHandlerDeps,
	) {}

	public processStreamData(data: CLIStreamData, sessionId?: string): void {
		// Only log non-streaming events to reduce spam
		if (
			data.type !== 'part-update' &&
			data.type !== 'message-update' &&
			data.type !== 'stream_event'
		) {
			logger.debug('[StreamHandler] Received:', data.type);
		}

		switch (data.type) {
			case 'system':
				if (data.subtype === 'init' && data.sessionId) {
					this._handleSystemInit(data, sessionId);
					return;
				}
				if (data.subtype === 'compact_boundary') {
					this._handleContextCompacted(sessionId, data.compactMetadata);
					return;
				}
				break;

			case 'assistant':
				if (data.message) {
					this._handleAssistantMessage(data, sessionId);
				}
				break;

			case 'user':
				if (data.message) {
					this._handleUserMessage(data, sessionId);
				}
				break;

			case 'result':
				this._handleResult(data, sessionId);
				break;

			case 'error':
				this._handleError(data, sessionId);
				break;

			case 'part-update':
				this._handlePartUpdate(data, sessionId);
				break;

			case 'message-update':
				this._handleMessageUpdate(data, sessionId);
				break;

			case 'stream_event':
				this._handleStreamEvent(data, sessionId);
				break;

			case 'permission-required':
				this._deps.handleOpenCodeAccess(data);
				break;

			case 'session-updated':
				this._handleSessionUpdated(data, sessionId);
				break;

			case 'thinking':
				this._handleThinking(data, sessionId);
				break;

			case 'subtask':
				this._handleSubtask(data, sessionId);
				break;

			case 'child-session-created':
				if (data.childSession) {
					// Link childSessionId to the subtask in SessionContext for persistence
					if (sessionId && data.childSession.id) {
						const session = this._sessionManager.getSession(sessionId);
						if (session) {
							session.linkChildSessionToSubtask(data.childSession.id);
						}
					}

					this._deps.postMessage({
						type: 'child-session-created',
						data: data.childSession,
						sessionId,
					});
				}
				break;

			case 'session-idle':
				this._handleSessionIdle(data, sessionId);
				break;

			default:
				logger.debug('[StreamHandler] Unhandled data type:', data.type);
		}
	}

	public handleProcessError(error: Error, sessionId?: string): void {
		this._deps.postMessage({ type: 'clearLoading', sessionId });

		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		if (session) {
			session.setProcessing(false);
		}

		this._deps.postMessage({ type: 'setProcessing', data: { isProcessing: false, sessionId } });

		if (CLIServiceFactory.isOpenCode()) {
			const errorMessage = error.message || 'An error occurred. Please try again.';
			this._deps.sendAndSaveMessage(
				{
					type: 'error',
					data: { content: errorMessage },
				},
				sessionId,
			);
			return;
		}

		const processError = error instanceof ProcessError ? error : ProcessError.fromSpawnError(error);

		if (errorService.isAuthError(processError)) {
			this._deps.handleLoginRequired(sessionId);
			return;
		}

		this._deps.sendAndSaveMessage(
			{ type: 'error', data: { content: processError.userMessage } },
			sessionId,
		);
	}

	// =========================================================================
	// Private Handlers
	// =========================================================================

	private _handleSystemInit(data: CLIStreamData, sessionId?: string): void {
		if (sessionId && data.sessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				session.setCLISessionId(data.sessionId);
			}
		} else if (data.sessionId) {
			const activeSession = this._sessionManager.getActiveSession();
			if (activeSession && !activeSession.cliSessionId) {
				activeSession.setCLISessionId(data.sessionId);
			}
		}

		this._deps.sendAndSaveMessage(
			{
				type: 'sessionInfo',
				data: {
					sessionId: data.sessionId,
					tools: data.tools || [],
					mcpServers: data.mcpServers || [],
				},
			},
			sessionId,
		);
	}

	private _handleAssistantMessage(data: CLIStreamData, sessionId?: string): void {
		const message = data.message;
		if (!message) return;

		logger.debug(
			`[StreamHandler] Assistant message received: contentTypes=[${message.content?.map((c: { type: string }) => c.type).join(', ')}], hasUsage=${!!message.usage}`,
		);

		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		if (session) {
			session.setReceivedResponse(true);
		}

		if (message.usage) {
			this._updateTokenStats(message.usage, sessionId);
		}

		// Check if we already received streamed text content
		// If so, skip the final assistant message text to avoid duplicates
		const hasStreamedText = session?.hasStreamedTextContent ?? false;

		for (const content of message.content) {
			if (content.type === 'text' && content.text?.trim()) {
				// Skip text content if we already received it via stream_event
				if (hasStreamedText) {
					logger.debug(
						`[StreamHandler] Skipping final text content (already streamed): length=${content.text.length}`,
					);
					continue;
				}
				logger.debug(
					`[StreamHandler] Text content: length=${content.text.length}, preview="${content.text.substring(0, 100)}..."`,
				);
				// Generate fallback ID for proxy models that don't provide content.id
				const partId = content.id || `text-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
				this._deps.sendAndSaveMessage(
					{ type: 'assistant', content: content.text.trim(), partId },
					sessionId,
				);
			} else if (content.type === 'thinking' && content.thinking?.trim()) {
				// Generate fallback ID for proxy models that don't provide content.id/cot_id
				const stableId =
					content.id ||
					content.cot_id ||
					`thinking-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
				this._deps.sendAndSaveMessage(
					{
						type: 'thinking',
						content: content.thinking.trim(),
						partId: stableId,
					},
					sessionId,
				);
			} else if (content.type === 'tool_use' && content.name && content.id) {
				this._handleToolUse(
					{
						name: content.name,
						id: content.id,
						input: content.input as { file_path?: string; todos?: unknown[] },
					},
					sessionId,
				);
			}
		}
	}

	private _handleUserMessage(data: CLIStreamData, sessionId?: string): void {
		if (!data.message?.content) return;

		// Use UI sessionId (passed as parameter) instead of data.sessionId (CLI session ID from SDK)
		// The UI expects UI session IDs, not CLI internal session IDs
		const uiSessionId = sessionId;

		for (const content of data.message.content) {
			if (content.type === 'tool_result' && content.tool_use_id) {
				const lastTool = this._getLastToolUse();
				const toolName = lastTool?.type === 'tool_use' ? lastTool.toolName : undefined;

				logger.debug('[StreamHandler] Processing tool_result:', {
					tool_use_id: content.tool_use_id,
					lastToolId: lastTool?.type === 'tool_use' ? lastTool.toolUseId : undefined,
					toolName,
					uiSessionId,
					cliSessionId: data.sessionId,
				});

				const textContent =
					typeof content.content === 'object'
						? JSON.stringify(content.content, null, 2)
						: String(content.content || 'Tool executed successfully');

				this._deps.sendAndSaveMessage(
					{
						type: 'tool_result',
						content: textContent,
						isError: content.is_error || false,
						toolUseId: content.tool_use_id,
						toolName: toolName || 'unknown',
					},
					uiSessionId,
				);

				// Send streamingComplete to mark the tool as finished in UI
				// The partId should match the tool_use id so UI can find and update it
				// Use UI sessionId, not CLI sessionId from data
				this._deps.postMessage({
					type: 'streamingComplete',
					data: { partId: content.tool_use_id, toolUseId: content.tool_use_id },
					sessionId: uiSessionId,
				});
			}
		}
	}

	private _handleResult(data: CLIStreamData, sessionId?: string): void {
		logger.debug(
			`[StreamHandler] Result received: subtype="${data.subtype}", isError=${data.isError}, result="${data.result?.substring(0, 200)}"`,
		);

		// Primary check: use isError flag as the source of truth
		// SDK may return error_during_execution subtype even when response was successful
		// (e.g., when using proxy that returns non-standard responses)
		if (data.isError === false || data.subtype === 'success') {
			this._handleResultSuccess(data, sessionId);
		} else if (data.isError === true || data.subtype === 'error_during_execution') {
			this._handleResultError(data, sessionId);
		}
	}

	private _handleResultSuccess(data: CLIStreamData, sessionId?: string): void {
		logger.debug(
			`[StreamHandler] Result success: cost=${data.totalCostUsd}, duration=${data.durationMs}, turns=${data.numTurns}`,
		);

		if (data.isError && data.result?.includes('Invalid API key')) {
			this._deps.handleLoginRequired(sessionId);
			return;
		}

		// Finalize any active thinking timers before completing the request
		this._finalizeThinkingTimers(sessionId);

		if (sessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				session.setProcessing(false);
				if (data.sessionId) session.setCLISessionId(data.sessionId);

				// Update token stats from result if available (Claude CLI sends final usage here)
				if (data.usage) {
					this._updateTokenStats(data.usage, sessionId);
				}

				session.updateStats(data.totalCostUsd, data.durationApiMs ?? data.durationMs);

				if (!session.receivedResponse) {
					logger.warn(
						`[StreamHandler] No response received from model for session ${sessionId}. Raw data: ${JSON.stringify(data).substring(0, 500)}`,
					);
				}

				this._deps.postMessage({
					type: 'updateTotals',
					data: {
						totalCost: session.totalCost,
						totalTokensInput: session.totalTokensInput,
						totalTokensOutput: session.totalTokensOutput,
						totalReasoningTokens: session.totalReasoningTokens,
						totalDuration: session.totalDuration,
						requestCount: session.requestCount,
						currentCost: data.totalCostUsd,
						currentDuration: data.durationMs,
						currentTurns: data.numTurns,
					},
					sessionId,
				});
			}
		}

		this._deps.postMessage({
			type: 'setProcessing',
			data: { isProcessing: false, sessionId },
		});
	}

	private _handleResultError(data: CLIStreamData, sessionId?: string): void {
		// Finalize any active thinking timers before completing the request
		this._finalizeThinkingTimers(sessionId);

		if (sessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				session.setProcessing(false);
				if (data.sessionId) session.setCLISessionId(data.sessionId);

				// Update token stats from result if available (even on error, tokens may have been used)
				if (data.usage) {
					this._updateTokenStats(data.usage, sessionId);
				}

				if (data.totalCostUsd) {
					session.updateStats(data.totalCostUsd, data.durationApiMs ?? data.durationMs);
					this._deps.postMessage({
						type: 'updateTotals',
						data: {
							totalCost: session.totalCost,
							totalTokensInput: session.totalTokensInput,
							totalTokensOutput: session.totalTokensOutput,
							totalReasoningTokens: session.totalReasoningTokens,
							totalDuration: session.totalDuration,
							requestCount: session.requestCount,
							currentCost: data.totalCostUsd,
							currentDuration: data.durationApiMs ?? data.durationMs,
							currentTurns: data.numTurns,
						},
						sessionId,
					});
				}
			}
		}

		this._deps.postMessage({
			type: 'setProcessing',
			data: { isProcessing: false, sessionId },
		});

		const errorMessage =
			data.result || 'An error occurred during execution. The API may have returned an error.';
		this._deps.sendAndSaveMessage({ type: 'error', data: { content: errorMessage } }, sessionId);
	}

	private _handleError(data: CLIStreamData, sessionId?: string): void {
		const errorMessage = data.result || JSON.stringify(data);
		this._deps.sendAndSaveMessage({ type: 'error', data: { content: errorMessage } }, sessionId);
	}

	private _handlePartUpdate(data: CLIStreamData, sessionId?: string): void {
		const part = data.part;
		if (!part) return;

		// Log child session events for debugging
		if (data.childSessionId) {
			logger.debug(
				`[StreamHandler] Part update from child session: type=${part.type}, childSessionId=${data.childSessionId}, partId=${part.id}`,
			);
		}

		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		if (session) {
			session.setReceivedResponse(true);
		}

		// OpenCode checkpoint creation
		if (
			CLIServiceFactory.isOpenCode() &&
			session &&
			!session.checkpointCreated &&
			part.messageID &&
			session.cliSessionId
		) {
			session.setCheckpointCreated(true);
			this._deps.createBackup('User message', part.messageID, sessionId);
		}

		// Skip user message parts
		if (part.messageID && session) {
			const role = session.messageRoles.get(part.messageID);
			if (role === 'user') return;
		}

		const partId = part.id;
		// Track if this event is from a child session (subtask/subagent)
		const childSessionId = data.childSessionId;

		// Debug: log all part types to diagnose missing tool events
		logger.debug(
			`[StreamHandler] part-update: type=${part.type}, tool=${part.tool || 'none'}, id=${partId?.substring(0, 8)}`,
		);

		switch (part.type) {
			case 'text':
				if (part.text?.trim() && partId && session) {
					const text = part.text.trim();

					// Extract thinking content from text if present (e.g. <thinking>...</thinking>)
					// This handles cases where the model outputs thinking tags within the text stream
					// instead of using a separate thinking part/field.
					const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
					const openThinkingRegex = /<thinking>([\s\S]*)$/;

					let thinkingContent = '';

					// 1. Handle complete thinking blocks
					let match: RegExpExecArray | null = thinkingRegex.exec(text);
					while (match !== null) {
						thinkingContent += (thinkingContent ? '\n\n' : '') + match[1];
						match = thinkingRegex.exec(text);
					}

					// 2. Handle unclosed thinking block at the end (for streaming)
					// Strategy: remove complete blocks, then check for open block.
					let cleanText = text.replace(thinkingRegex, '').trim();

					const remainingOpenMatch = cleanText.match(openThinkingRegex);
					if (remainingOpenMatch) {
						thinkingContent += (thinkingContent ? '\n\n' : '') + remainingOpenMatch[1];
						cleanText = cleanText.replace(openThinkingRegex, '').trim();
					}

					if (thinkingContent) {
						const thinkingPartId = `${partId}-thinking`;
						this._deps.sendAndSaveMessage(
							{
								type: 'thinking',
								content: thinkingContent.trim(),
								partId: thinkingPartId,
							},
							sessionId,
						);
						session.lastPartContent.set(thinkingPartId, thinkingContent.trim());
					}

					if (cleanText) {
						// Pass partId to enable proper streaming merge logic in SessionContext
						// Include childSessionId if this is from a subtask/subagent
						this._deps.sendAndSaveMessage(
							{
								type: 'assistant',
								content: cleanText,
								partId,
								childSessionId,
								hidden: !!childSessionId, // Hide from main flow if from child session
							},
							sessionId,
						);
						session.lastPartContent.set(partId, cleanText);
					}
				}
				break;

			case 'reasoning':
			case 'thinking':
				this._handlePartThinking(part, sessionId, session);
				break;

			case 'step-finish':
				// Finalize any active thinking timers for this message
				this._finalizeThinkingTimers(sessionId);
				this._flushPartContent(part.messageID, sessionId);
				// Note: Tokens are handled via message.updated event which has cumulative totals
				// Don't process step-finish tokens to avoid double counting
				break;

			case 'tool':
				if (part.tool && part.state) {
					this._handleOpenCodeToolUse(part, sessionId, childSessionId);
				}
				break;

			default:
				// Silently ignore unknown part types to reduce log spam
				break;
		}
	}

	private _handlePartThinking(
		part: NonNullable<CLIStreamData['part']>,
		sessionId?: string,
		session?: { lastPartContent: Map<string, string> },
	): void {
		if (!part.id || !session) return;

		const fullSession = sessionId ? this._sessionManager.getSession(sessionId) : undefined;

		const reasoningText =
			part.text?.trim() || part.reasoning_text?.trim() || part.cot_summary?.trim();

		if (reasoningText) {
			let formattedThinking = reasoningText;
			if (part.cot_id) {
				formattedThinking = `**${part.cot_id}**\n\n${formattedThinking}`;
			}

			// Start thinking timer if not already started
			if (fullSession) {
				fullSession.startThinkingTimer(part.id);
			}

			// Get reasoning tokens from part if available
			const reasoningTokens = part.tokens?.reasoning;

			// Get startTime for frontend to compute elapsed (no frontend timer needed)
			const startTime = fullSession?.getThinkingStartTime(part.id);

			// Pass partId to enable proper streaming merge logic in SessionContext
			// partId uniquely identifies this thinking block, allowing updates to the same block
			// while creating new blocks when a different partId arrives
			this._deps.sendAndSaveMessage(
				{
					type: 'thinking',
					content: formattedThinking,
					partId: part.id,
					isStreaming: true,
					startTime,
					reasoningTokens,
				},
				sessionId,
			);
			session.lastPartContent.set(`thinking_${part.id}`, formattedThinking);
		}
	}

	private _handleMessageUpdate(data: CLIStreamData, sessionId?: string): void {
		if (data.fullMessage?.id && data.fullMessage?.role && sessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				session.messageRoles.set(data.fullMessage.id, data.fullMessage.role);
			}
		}

		// Skip token stats update for child session events (subagents have isolated context)
		// Their tokens should not be added to the parent session's total
		if (data.message?.usage && !data.childSessionId) {
			this._updateTokenStats(data.message.usage, sessionId);

			// Count API calls for OpenCode: each unique assistant message with tokens is an API call
			if (sessionId && data.fullMessage?.id && data.fullMessage?.role === 'assistant') {
				const session = this._sessionManager.getSession(sessionId);
				if (session) {
					const messageId = data.fullMessage.id;
					// Only count if this message has output tokens (completed response)
					const hasOutput = (data.message.usage.output_tokens || 0) > 0;
					if (hasOutput) {
						session.recordApiCall(messageId);
					}
				}
			}
		}

		// Aggregate durationMs for OpenCode (comes from message.updated event)
		// Also skip for child sessions
		if (data.durationMs && sessionId && !data.childSessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				const messageId = data.fullMessage?.id;
				if (messageId) {
					session.recordDuration(messageId, data.durationMs);
				}
			}
		}
	}

	private _handleSessionUpdated(data: CLIStreamData, sessionId?: string): void {
		if (data.sessionId && sessionId && data.sessionId !== sessionId) {
			// OpenCodeService should already filter events by CLI session.
			// This guard prevents corrupting UI session mapping if any cross-session event slips through.
			return;
		}

		if (data.sessionId && sessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				session.setCLISessionId(data.sessionId);
			}
		}
	}

	/**
	 * Handle session-idle event (OpenCode).
	 * Send updateTotals with final stats and notify UI.
	 * Also stops processing to ensure timers are stopped on errors/cancellations.
	 */
	private _handleSessionIdle(data: CLIStreamData, sessionId?: string): void {
		if (sessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				// Stop processing - session is idle (error, cancel, completion, etc.)
				session.setProcessing(false);
				session.setAutoRetrying(false);

				// Send final stats to UI
				this._deps.postMessage({
					type: 'updateTotals',
					data: {
						totalCost: session.totalCost,
						totalTokensInput: session.totalTokensInput,
						totalTokensOutput: session.totalTokensOutput,
						totalReasoningTokens: session.totalReasoningTokens,
						totalDuration: session.totalDuration,
						requestCount: session.requestCount,
					},
					sessionId,
				});
			}
		}

		this._deps.postMessage({
			type: 'sessionIdle',
			data: { sessionId: data.sessionId || sessionId },
			sessionId,
		});

		// Notify UI to stop processing (ensures timers stop on error/cancel/reload)
		this._deps.postMessage({
			type: 'setProcessing',
			data: { isProcessing: false, sessionId },
		});
	}

	/**
	 * Handle session.status events from OpenCode (idle, busy, retry).
	 * When status is 'retry', OpenCode SDK is automatically retrying the request.
	 * We notify the UI so it can show retry progress instead of manual Resume button.
	 */
	private _handleSessionStatusEvent(data: CLIStreamData, sessionId?: string): void {
		// First try to use the direct sessionStatus field (new approach)
		let status:
			| {
					type: 'idle' | 'busy' | 'retry';
					attempt?: number;
					message?: string;
					next?: number;
			  }
			| undefined;

		if (data.sessionStatus) {
			status = { type: data.sessionStatus };
		} else if (data.message?.content?.[0]?.text) {
			// Fallback: parse from message content (legacy approach)
			try {
				const parsed = JSON.parse(data.message.content[0].text);
				status = parsed.status;
			} catch (e) {
				logger.error('[StreamHandler] Failed to parse session.status data', e);
				return;
			}
		}

		if (!status?.type) return;

		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;

		logger.debug(
			`[StreamHandler] Session status: ${status.type}${status.attempt ? ` (attempt ${status.attempt})` : ''}, sessionId=${sessionId}`,
		);

		switch (status.type) {
			case 'retry':
				// OpenCode is auto-retrying - notify UI to show retry status
				this._deps.postMessage({
					type: 'sessionRetrying',
					data: {
						sessionId: data.sessionId || sessionId,
						attempt: status.attempt || 1,
						message: status.message || 'Retrying request...',
						nextRetryAt: status.next ? new Date(status.next).toISOString() : undefined,
					},
					sessionId,
				});

				// Mark session as auto-retrying so UI doesn't show manual Resume button
				if (session) {
					session.setAutoRetrying(true);
				}
				break;

			case 'idle':
				// Session is idle - clear retry state
				if (session) {
					session.setAutoRetrying(false);
					session.setProcessing(false);
				}
				this._deps.postMessage({
					type: 'sessionIdle',
					data: { sessionId: data.sessionId || sessionId },
					sessionId,
				});
				this._deps.postMessage({
					type: 'setProcessing',
					data: { isProcessing: false, sessionId },
				});
				break;

			case 'busy':
				// Session is busy processing
				if (session) {
					session.setAutoRetrying(false);
					session.setProcessing(true);
				}
				this._deps.postMessage({
					type: 'setProcessing',
					data: { isProcessing: true, sessionId },
				});
				break;

			default:
				logger.debug(`[StreamHandler] Unknown session status: ${status.type}`);
		}
	}

	private _handleContextCompacted(
		sessionId: string | undefined,
		compactMetadata?: CLIStreamData['compactMetadata'],
	): void {
		const targetSessionId = sessionId || this._sessionManager.activeSessionId;
		if (!targetSessionId) {
			return;
		}

		const metadataPreview = compactMetadata
			? ` (trigger=${compactMetadata.trigger}, preTokens=${compactMetadata.preTokens})`
			: '';
		logger.info(`[StreamHandler] Context compacted${metadataPreview}`);

		this._deps.sendAndSaveMessage(
			{
				type: 'system_notice',
				content: 'Context summarized',
			},
			targetSessionId,
		);
	}

	/**
	 * Handle stream_event for partial message updates (--include-partial-messages)
	 * These events contain incremental text/thinking deltas for real-time streaming
	 */
	private _handleStreamEvent(data: CLIStreamData, sessionId?: string): void {
		// Minimal logging - only log non-delta events to reduce spam
		const eventType = data.streamEvent?.event?.type || data.subtype || 'unknown';
		if (eventType !== 'content_block_delta') {
			logger.debug(`[StreamHandler] stream_event: ${eventType}, sessionId=${sessionId}`);
		}

		// Handle OpenCode session.status events (idle, busy, retry)
		if (data.subtype === 'session.status') {
			this._handleSessionStatusEvent(data, sessionId);
			return;
		}

		if (data.subtype === 'session.compacted') {
			this._handleContextCompacted(sessionId);
			return;
		}

		// Handle OpenCode-specific notification events via subtype
		if (data.subtype === 'project.updated') {
			if (data.message?.content?.[0]?.text) {
				try {
					const project = JSON.parse(data.message.content[0].text);
					this._deps.postMessage({
						type: 'projectUpdated',
						data: { project },
						sessionId,
					});
				} catch (e) {
					logger.error('[StreamHandler] Failed to parse project.updated data', e);
				}
			}
			return;
		}

		if (data.subtype === 'message.part.removed') {
			if (data.message?.content?.[0]?.text) {
				try {
					const partData = JSON.parse(data.message.content[0].text);
					this._deps.postMessage({
						type: 'messagePartRemoved',
						data: partData,
						sessionId,
					});
				} catch (e) {
					logger.error('[StreamHandler] Failed to parse message.part.removed data', e);
				}
			}
			return;
		}

		const streamEvent = data.streamEvent;
		if (!streamEvent?.event) {
			logger.debug('[StreamHandler] stream_event received but no event data');
			return;
		}

		logger.debug(
			`[StreamHandler] stream_event: type=${streamEvent.event.type}, uuid=${streamEvent.uuid?.substring(0, 8)}`,
		);

		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		if (session) {
			session.setReceivedResponse(true);
		}

		const event = streamEvent.event;
		const uuid = streamEvent.uuid;
		const parentToolUseId = streamEvent.parentToolUseId;
		// Use stable key for grouping events of the same session.
		// Prefer UI sessionId (stable), otherwise fall back to CLI session_id.
		const responseKey = sessionId || data.sessionId || uuid;

		// IMPORTANT:
		// - We need a per-assistant-message key so post-tool_use text doesn't overwrite pre-tool_use text.
		// - BUT it must remain stable across all events of the SAME message, otherwise the UI will
		//   create a new message for each delta ("слово на строку").
		// We build a stable message key per "message_start" and reuse it for subsequent blocks.
		if (session && event.type === 'message_start') {
			session.setActiveStreamPart(-1, uuid);
		}
		const messageKey = session ? session.getActiveStreamPart(-1) || uuid : uuid;

		// Handle different stream event types
		switch (event.type) {
			case 'content_block_start': {
				// New content block starting - could be text, thinking, or tool_use
				const block = event.content_block;
				if (block?.type === 'text') {
					// Initialize text streaming with empty content
					// Use the same partId as subsequent deltas so the UI updates a single message.
					const streamIndex = event.index ?? 0;
					const partId = block.id || `stream-text-${responseKey}-${messageKey}-${streamIndex}-text`;
					this._deps.sendAndSaveMessage(
						{ type: 'assistant', content: '', partId, isStreaming: true },
						sessionId,
					);
				} else if (block?.type === 'thinking') {
					const partId = block.id || `stream-thinking-${responseKey}-${messageKey}`;
					// Start thinking timer and get startTime for frontend
					if (session) {
						session.startThinkingTimer(partId);
					}
					const startTime = session?.getThinkingStartTime(partId);
					this._deps.sendAndSaveMessage(
						{ type: 'thinking', content: '', partId, isStreaming: true, startTime },
						sessionId,
					);
				} else if (block?.type === 'tool_use') {
					// Initialize tool use streaming
					const partId = block.id || `stream-tool-${responseKey}`;
					this._handleToolUse(
						{
							name: block.name || 'Unknown',
							id: partId,
							input: {},
							parentToolUseId,
						},
						sessionId,
					);
				}
				break;
			}

			case 'content_block_delta': {
				// Incremental update to content block
				const delta = event.delta;
				if (this._shouldLogStreamDelta(sessionId)) {
					logger.info(
						`[StreamHandler] content_block_delta: delta.type=${delta?.type}, textPreview="${delta?.text?.substring(0, 80) || ''}", hasThinking=${
							(delta as { thinking?: unknown } | undefined)?.thinking !== undefined
						}, hasPartialJson=${
							(delta as { partial_json?: unknown } | undefined)?.partial_json !== undefined
						}, sessionId=${sessionId}`,
					);
				}
				if (delta?.type === 'text_delta') {
					const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
					if (!session) {
						const allSessions = this._sessionManager.getAllSessions();
						logger.warn(
							`[StreamHandler] No session found for text_delta, sessionId=${sessionId}, availableSessions=[${allSessions.map(s => s.uiSessionId).join(', ')}]`,
						);
						break;
					}

					// Handle empty text (first chunk often has empty content)
					if (!delta.text) {
						break;
					}

					const streamIndex = event.index ?? 0;

					// Some models put thinking into plain text with <thinking>...</thinking> tags.
					// This parser is streaming-safe: it buffers partial tags per stream index.
					const chunk = delta.text;
					const buffered = session.getStreamBuffer(streamIndex);
					const text = buffered + chunk;

					let cursor = 0;
					let remaining = '';

					const emitAssistant = (content: string, kind: 'pre' | 'text' | 'rest') => {
						if (!content) return;
						const partId = `stream-text-${responseKey}-${messageKey}-${streamIndex}-${kind}`;

						// UI store overwrites by id, so send cumulative content for each partId.
						const prev = session.lastPartContent.get(partId) || '';
						const next = prev + content;
						session.lastPartContent.set(partId, next);

						this._deps.sendAndSaveMessage(
							{
								type: 'assistant',
								content: next,
								partId,
								isStreaming: true,
							},
							sessionId,
						);
					};

					const emitThinking = (content: string) => {
						if (!content) return;
						const partId =
							session.getActiveStreamPart(streamIndex) ||
							`stream-thinking-${responseKey}-${messageKey}-${streamIndex}`;
						session.setActiveStreamPart(streamIndex, partId);

						// Start thinking timer if not already started
						session.startThinkingTimer(partId);

						// UI store deduplicates by id and overwrites content, so we must send cumulative content.
						const prev = session.lastPartContent.get(partId) || '';
						const next = prev + content;
						session.lastPartContent.set(partId, next);

						const startTime = session.getThinkingStartTime(partId);
						this._deps.sendAndSaveMessage(
							{
								type: 'thinking',
								content: next,
								partId,
								isStreaming: true,
								startTime,
							},
							sessionId,
						);
					};

					while (cursor < text.length) {
						if (session.isStreamingThinking) {
							const closeIdx = text.indexOf('</thinking>', cursor);
							if (closeIdx === -1) {
								// Entire remainder belongs to thinking; keep in buffer if it ends with partial closing tag.
								const fragment = text.substring(cursor);
								const lastLt = fragment.lastIndexOf('<');
								if (lastLt !== -1) {
									const tail = fragment.substring(lastLt);
									if ('</thinking>'.startsWith(tail)) {
										emitThinking(fragment.substring(0, lastLt));
										remaining = tail;
										cursor = text.length;
										break;
									}
								}
								emitThinking(fragment);
								cursor = text.length;
								break;
							}

							// Found closing tag
							emitThinking(text.substring(cursor, closeIdx));
							// Get final duration and send final message with durationMs
							const thinkingPartId = session.getActiveStreamPart(streamIndex);
							if (thinkingPartId) {
								const durationMs = session.stopThinkingTimer(thinkingPartId);
								const finalContent = session.lastPartContent.get(thinkingPartId) || '';
								this._deps.sendAndSaveMessage(
									{
										type: 'thinking',
										content: finalContent,
										partId: thinkingPartId,
										isStreaming: false,
										durationMs,
									},
									sessionId,
								);
							}
							session.setStreamingThinking(false);
							session.clearActiveStreamPart(streamIndex);
							cursor = closeIdx + '</thinking>'.length;
							continue;
						}

						const openIdx = text.indexOf('<thinking>', cursor);
						if (openIdx === -1) {
							const fragment = text.substring(cursor);
							const lastLt = fragment.lastIndexOf('<');
							if (lastLt !== -1) {
								const tail = fragment.substring(lastLt);
								if ('<thinking>'.startsWith(tail)) {
									emitAssistant(fragment.substring(0, lastLt), 'text');
									remaining = tail;
									cursor = text.length;
									break;
								}
							}
							emitAssistant(fragment, 'text');
							cursor = text.length;
							break;
						}

						// Emit assistant content before the opening tag
						if (openIdx > cursor) {
							emitAssistant(text.substring(cursor, openIdx), 'pre');
						}

						// Switch to thinking mode after consuming <thinking>
						cursor = openIdx + '<thinking>'.length;
						session.setStreamingThinking(true);
					}

					session.setStreamBuffer(streamIndex, remaining);
					session.setHasStreamedTextContent(true);
				} else if (delta?.type === 'thinking_delta' && delta.thinking) {
					const partId = `stream-thinking-${responseKey}-${messageKey}-${event.index ?? 0}`;
					// Start thinking timer if not already started
					if (session) {
						session.startThinkingTimer(partId);
					}
					const startTime = session?.getThinkingStartTime(partId);
					this._deps.sendAndSaveMessage(
						{
							type: 'thinking',
							content: delta.thinking,
							partId,
							isStreaming: true,
							isDelta: true,
							startTime,
						},
						sessionId,
					);
				} else if (delta?.type === 'input_json_delta' && delta.partial_json) {
					// Intentionally ignore tool input deltas for now.
					// We currently render tool input only once we have the final tool_use payload.
				}
				break;
			}

			case 'content_block_stop': {
				// Content block finished - mark streaming complete
				const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
				const streamIndex = event.index ?? 0;
				if (session) {
					// Finalize any active thinking block with duration
					const thinkingPartId = session.getActiveStreamPart(streamIndex);
					if (thinkingPartId) {
						const durationMs = session.stopThinkingTimer(thinkingPartId);
						const finalContent = session.lastPartContent.get(thinkingPartId) || '';
						if (finalContent) {
							this._deps.sendAndSaveMessage(
								{
									type: 'thinking',
									content: finalContent,
									partId: thinkingPartId,
									isStreaming: false,
									durationMs,
								},
								sessionId,
							);
						}
					}
					session.clearStreamBuffer(streamIndex);
					session.setStreamingThinking(false);
					session.clearActiveStreamPart(streamIndex);
					// Clear accumulated cumulative buffers for this streaming response
					session.lastPartContent.clear();
					session.clearThinkingTimers();
				}
				const partId = `stream-${responseKey}-${streamIndex}`;
				this._deps.postMessage({
					type: 'streamingComplete',
					data: { partId },
					sessionId,
				});
				break;
			}

			case 'message_start':
			case 'message_delta':
			case 'message_stop':
				// Message-level events - can be used for usage stats etc.
				break;

			case 'error': {
				// Handle SSE error event from proxy/backend
				const errorData = event as { error?: { type?: string; message?: string } };
				const errorMessage = errorData.error?.message || 'An error occurred during streaming';
				logger.error(`[StreamHandler] SSE error event: ${errorMessage}`);

				// Send error to UI
				this._deps.sendAndSaveMessage(
					{ type: 'error', data: { content: errorMessage } },
					sessionId,
				);

				// Stop processing
				this._deps.postMessage({
					type: 'setProcessing',
					data: { isProcessing: false, sessionId },
				});
				break;
			}

			default:
				// Unknown event type - log for debugging
				logger.debug(`[StreamHandler] Unknown stream event type: ${event.type}`);
		}
	}

	private _handleThinking(data: CLIStreamData, sessionId?: string): void {
		if (data.message?.content?.[0]) {
			const thinkingContent = data.message.content[0];
			const thinkingText =
				thinkingContent.thinking ||
				thinkingContent.cot_summary ||
				thinkingContent.reasoning_text ||
				thinkingContent.text;

			if (thinkingText?.trim()) {
				let formattedThinking = thinkingText.trim();
				if (thinkingContent.cot_id) {
					formattedThinking = `**${thinkingContent.cot_id}**\n\n${formattedThinking}`;
				}
				const stableId = thinkingContent.cot_id || data.message?.id;
				if (!stableId) {
					throw new Error(
						'[StreamHandler] thinking event is missing cot_id/message.id; cannot provide stable streaming identity',
					);
				}
				this._deps.sendAndSaveMessage(
					{
						type: 'thinking',
						content: formattedThinking,
						partId: stableId,
					},
					sessionId,
				);
			}
		}
	}

	private _handleSubtask(data: CLIStreamData, sessionId?: string): void {
		if (!data.subtask) return;
		const status = data.subtask.status || 'running';

		this._deps.sendAndSaveMessage(
			{
				type: 'subtask',
				id: data.subtask.id,
				timestamp: new Date().toISOString(),
				agent: data.subtask.agent,
				prompt: data.subtask.prompt,
				description: data.subtask.description,
				command: data.subtask.command,
				status,
				result: data.subtask.result,
				messageID: data.subtask.messageID,
			},
			sessionId,
		);
	}

	private _handleOpenCodeToolUse(
		part: NonNullable<CLIStreamData['part']>,
		sessionId?: string,
		childSessionId?: string,
	): void {
		const toolName = part.tool || 'Unknown';
		const state = part.state;
		const toolNameLower = toolName.toLowerCase();
		const toolNameDisplay = toolName.charAt(0).toUpperCase() + toolName.slice(1);
		const toolUseId = part.callID || part.id || '';

		const input = state?.input as {
			filePath?: string;
			file_path?: string;
			content?: string;
			startLine?: number;
			endLine?: number;
			old_string?: string;
			new_string?: string;
			old_str?: string;
			new_str?: string;
			oldString?: string;
			newString?: string;
		};
		const filePath = input?.filePath || input?.file_path;

		// Calculate lines added/removed from old/new content
		const oldContent = input?.old_string || input?.old_str || input?.oldString || '';
		const newContent =
			input?.new_string || input?.new_str || input?.newString || input?.content || '';

		// Count actual lines (empty string = 0 lines, "a" = 1 line, "a\nb" = 2 lines)
		const countLines = (str: string): number => {
			if (!str) return 0;
			// Count newlines + 1 for the last line (if content is not empty)
			return str.split('\n').length;
		};

		const oldLines = countLines(oldContent);
		const newLines = countLines(newContent);
		const linesAdded = Math.max(0, newLines - oldLines);
		const linesRemoved = Math.max(0, oldLines - newLines);

		if (
			state?.status === 'running' ||
			state?.status === 'completed' ||
			state?.status === 'pending'
		) {
			// Mark this toolUseId as created so AccessHandler doesn't duplicate it
			// This is the single source of truth for tool_use creation
			this._deps.markToolUseCreated?.(toolUseId);

			// Extract streaming output from metadata (SDK sends intermediate output here)
			// SDK structure: state.metadata.output contains the streaming output
			const metadata = state?.metadata as { output?: string; description?: string } | undefined;
			const streamingOutput = metadata?.output || state?.output;

			// Debug log to see what's coming from SDK
			if (state?.status === 'running' && toolNameLower === 'bash') {
				logger.debug('[StreamHandler] Bash running state:', {
					toolUseId,
					childSessionId,
					hasMetadata: !!metadata,
					metadataOutput: metadata?.output?.substring(0, 100),
					stateOutput: state?.output?.substring(0, 100),
					streamingOutput: streamingOutput?.substring(0, 100),
				});
			}

			this._deps.sendAndSaveMessage(
				{
					type: 'tool_use',
					toolName: toolNameDisplay,
					toolUseId,
					toolInput: '',
					rawInput: state?.input as Record<string, unknown>,
					filePath: filePath || undefined,
					// Include streaming output for running tools (e.g., Bash)
					streamingOutput: state?.status === 'running' ? streamingOutput : undefined,
					isRunning: state?.status === 'running',
					// Include childSessionId if this is from a subtask/subagent
					childSessionId,
					hidden: !!childSessionId, // Hide from main flow if from child session
				},
				sessionId,
			);

			if (state?.status === 'completed') {
				// Send fileChanged only on completion to avoid duplicate counting
				if (filePath && ['write', 'edit', 'multiedit'].includes(toolNameLower)) {
					// Save to session context for persistence
					if (sessionId) {
						const session = this._sessionManager.getSession(sessionId);
						if (session) {
							session.addChangedFile({
								filePath,
								fileName: filePath.split(/[/\\]/).pop() || filePath,
								linesAdded,
								linesRemoved,
								toolUseId,
								timestamp: Date.now(),
							});
						}
					}

					this._deps.postMessage({
						type: 'fileChanged',
						data: {
							filePath,
							changeType: toolNameLower === 'write' ? 'created' : 'modified',
							linesAdded,
							linesRemoved,
							toolUseId: part.callID || part.id || '',
						},
						sessionId,
					});
				}

				this._handleOpenCodeToolCompletion(
					state,
					toolNameLower,
					toolNameDisplay,
					part.callID || part.id,
					filePath,
					sessionId,
					newContent, // Pass content for token estimation
					childSessionId,
				);
			}
		} else if (state?.status === 'error') {
			this._deps.sendAndSaveMessage(
				{
					type: 'tool_result',
					content: state.error || 'Tool execution failed',
					isError: true,
					toolUseId: part.callID || part.id || '',
					toolName: toolNameDisplay,
					childSessionId,
					hidden: !!childSessionId,
				},
				sessionId,
			);
		}
	}

	private _handleOpenCodeToolCompletion(
		state: NonNullable<NonNullable<CLIStreamData['part']>['state']>,
		toolNameLower: string,
		toolNameDisplay: string,
		toolUseId: string,
		filePath?: string,
		sessionId?: string,
		fileContent?: string,
		childSessionId?: string,
	): void {
		const hiddenTools = ['read', 'write', 'edit', 'todowrite', 'multiedit', 'glob', 'grep'];
		const isHidden = hiddenTools.includes(toolNameLower);

		const originalOutput = state.output || '';
		let displayOutput = originalOutput;

		if (isHidden && displayOutput) {
			if (toolNameLower === 'read') {
				const lineCount = (displayOutput.match(/\n/g) || []).length + 1;
				displayOutput = `Read ${lineCount} lines from ${filePath || 'file'}`;
			} else if (toolNameLower === 'write') {
				displayOutput = `Successfully wrote to ${filePath || 'file'}`;
			} else if (['edit', 'multiedit'].includes(toolNameLower)) {
				displayOutput = `Successfully edited ${filePath || 'file'}`;
			} else if (['glob', 'grep'].includes(toolNameLower)) {
				const resultCount = (displayOutput.match(/\n/g) || []).length;
				displayOutput = `Found ${resultCount} results`;
			}
		}

		// Calculate estimated tokens:
		// - For file edit tools (write/edit): use file content length
		// - For read tool: use original output (file content)
		// - For other tools: use original output
		let tokenSource = originalOutput;
		if (['write', 'edit', 'multiedit'].includes(toolNameLower) && fileContent) {
			tokenSource = fileContent;
		}
		const estimatedTokens = tokenSource ? Math.ceil(tokenSource.length / 4) : 0;

		// Calculate duration from time.start and time.end
		const durationMs =
			state.time?.start && state.time?.end ? state.time.end - state.time.start : undefined;

		// Extract attachments (e.g., screenshots, generated images)
		const attachments = state.attachments?.map(att => ({
			id: att.id,
			mime: att.mime,
			filename: att.filename,
			url: att.url,
		}));

		this._deps.sendAndSaveMessage(
			{
				type: 'tool_result',
				content: displayOutput,
				isError: false,
				toolUseId,
				toolName: toolNameDisplay,
				estimatedTokens,
				// New fields from SDK
				title: state.title,
				durationMs,
				attachments: attachments?.length ? attachments : undefined,
				metadata: state.metadata,
				// Include childSessionId if this is from a subtask/subagent
				childSessionId,
				hidden: !!childSessionId,
			},
			sessionId,
		);
	}

	/**
	 * Finalize all active thinking timers for a session.
	 * Called on step-finish and result events to ensure timers don't leak.
	 */
	private _finalizeThinkingTimers(sessionId?: string): void {
		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		if (!session) return;

		// Get all active thinking part IDs and finalize them
		const thinkingTimers = session.getActiveThinkingTimers();
		for (const partId of thinkingTimers) {
			const durationMs = session.stopThinkingTimer(partId);
			const finalContent = session.lastPartContent.get(`thinking_${partId}`) || '';

			if (finalContent) {
				this._deps.sendAndSaveMessage(
					{
						type: 'thinking',
						content: finalContent,
						partId,
						isStreaming: false,
						durationMs,
					},
					sessionId,
				);
			}
		}
	}

	private _flushPartContent(messageID?: string, sessionId?: string): void {
		if (!messageID || !sessionId) return;

		const session = this._sessionManager.getSession(sessionId);
		if (!session) return;

		session.lastPartContent.clear();
	}

	private _updateTokenStats(usage: TokenUsageAPI, sessionId?: string): void {
		const session = sessionId
			? this._sessionManager.getSession(sessionId)
			: this._sessionManager.getActiveSession();

		// Log token updates for debugging
		logger.debug(
			`[StreamHandler] Token update: input=${usage.input_tokens}, output=${usage.output_tokens}, ` +
				`cache_read=${usage.cache_read_input_tokens}, cache_write=${usage.cache_creation_input_tokens}, ` +
				`reasoning=${usage.reasoning_tokens}, provider=${CLIServiceFactory.getCurrentProvider()}`,
		);

		if (session) {
			session.updateTokenUsage(usage);
		}

		// Use postMessage instead of sendAndSaveMessage - token stats should not be saved to conversation history
		this._deps.postMessage({
			type: 'updateTokens',
			data: {
				totalTokensInput: session?.totalTokensInput || 0,
				totalTokensOutput: session?.totalTokensOutput || 0,
				currentInputTokens: usage.input_tokens || 0,
				currentOutputTokens: usage.output_tokens || 0,
				cacheCreationTokens: usage.cache_creation_input_tokens || 0,
				cacheReadTokens: usage.cache_read_input_tokens || 0,
				reasoningTokens: usage.reasoning_tokens || 0,
				totalReasoningTokens: session?.totalReasoningTokens || 0,
			},
			sessionId,
		});
	}

	private _handleToolUse(content: ToolUseContent, sessionId?: string): void {
		logger.debug('[StreamHandler] Creating tool_use:', {
			toolName: content.name,
			toolUseId: content.id,
			sessionId,
		});

		let toolInput = '';
		if (content.name === 'TodoWrite' && content.input?.todos) {
			toolInput = (content.input as unknown as ToolInputWithTodos).todos
				.map(t => {
					const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◌' : '○';
					const text = t.status === 'completed' ? `~~${t.content}~~` : t.content;
					return `${mark} ${text}${t.priority ? ` (priority: ${t.priority})` : ''}`;
				})
				.join('\n');
		}

		this._deps.sendAndSaveMessage(
			{
				type: 'tool_use',
				toolName: content.name,
				toolUseId: content.id,
				toolInput,
				rawInput: content.input as Record<string, unknown>,
				filePath: content.input?.file_path || undefined,
				parentToolUseId: content.parentToolUseId,
			},
			sessionId,
		);
	}

	private _getLastToolUse() {
		const session = this._sessionManager.getActiveSession();
		const history = session?.conversationMessages ?? [];

		for (let i = history.length - 1; i >= 0; i--) {
			if (history[i].type === 'tool_use') {
				return history[i];
			}
		}
		return null;
	}

	/**
	 * Determine if stream delta events should be logged for debugging.
	 * Returns true only occasionally to avoid log spam.
	 */
	private _shouldLogStreamDelta(_sessionId?: string): boolean {
		// Log every 100th delta to reduce spam but still provide visibility
		if (!this._deltaLogCounter) {
			this._deltaLogCounter = 0;
		}
		this._deltaLogCounter++;
		return this._deltaLogCounter % 100 === 1;
	}

	private _deltaLogCounter = 0;
}
