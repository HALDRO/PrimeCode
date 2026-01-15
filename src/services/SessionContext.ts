/**
 * @file Session Context - Per-session state and services container
 * @description Encapsulates all state and services for a single chat session.
 * Enables parallel session execution where multiple sessions can process
 * messages simultaneously. Sessions share a single CLI service instance
 * (managed by SessionManager) to prevent multiple server spawns.
 * Each SessionContext owns its backup commits, conversation history, and usage counters.
 * Integrates BackupService and ConversationService for per-session isolation.
 * Implements proper lifecycle management with cleanup on session close.
 */

import type * as vscode from 'vscode';
import type { CommitInfo, ConversationData, ConversationMessage, TokenUsageAPI } from '../types';
import { logger } from '../utils/logger';
import { BackupService } from './BackupService';
import { ConversationService } from './ConversationService';
import type { CLIProcessOptions, CLIStreamData, ICLIService } from './ICLIService';

/**
 * Changed file information
 */
export interface ChangedFile {
	filePath: string;
	fileName: string;
	linesAdded: number;
	linesRemoved: number;
	toolUseId: string;
	timestamp: number;
}

/**
 * Session state snapshot for persistence/restore
 * Note: conversationMessages are stored in JSON files, not in globalState
 * to avoid exceeding VS Code's ~100KB limit per key.
 */
export interface SessionSnapshot {
	uiSessionId: string;
	cliSessionId: string | undefined;
	/** CLI provider type used for this session (opencode or claude) */
	providerType: 'opencode' | 'claude' | undefined;
	totalCost: number;
	totalTokensInput: number;
	totalTokensOutput: number;
	totalReasoningTokens: number;
	totalDuration: number;
	requestCount: number;
	isProcessing: boolean;
	commits: CommitInfo[];
	changedFiles: ChangedFile[];
	conversationFilename: string | undefined; // Reference to JSON file instead of full messages
	conversationStartTime: string | undefined;
	lastOpenCodeMessageId: string | undefined;
}

/**
 * Callbacks for session events (forwarded to ChatProvider)
 */
export interface SessionCallbacks {
	onData: (sessionId: string, data: CLIStreamData) => void;
	onClose: (sessionId: string, code: number | null, errorOutput: string) => void;
	onError: (sessionId: string, error: Error) => void;
	onCommitCreated: (sessionId: string, commit: CommitInfo) => void;
	onStateChanged?: (sessionId: string) => void;
}

/**
 * Per-session context containing all isolated state and services
 */
export class SessionContext {
	public readonly uiSessionId: string;

	// CLI service instance (owned by this session when created via initializeCLIService)
	private _cliService: ICLIService | null = null;
	private _ownsCliService: boolean = false;
	private _cliSessionId: string | undefined;
	/** CLI provider type used for this session (persisted for restore) */
	private _providerType: 'opencode' | 'claude' | undefined;

	// Usage counters
	private _totalCost: number = 0;
	private _mainTokensInput: number = 0;
	private _mainTokensOutput: number = 0;
	private _subagentTokensInput: number = 0;
	private _subagentTokensOutput: number = 0;
	private _totalReasoningTokens: number = 0;
	private _totalDuration: number = 0;
	private _requestCount: number = 0;

	// Track last known context size from main session (for UI display)
	private _lastMainContextSize: number = 0;

	// Processing state
	private _isProcessing: boolean = false;
	private _isAutoRetrying: boolean = false;
	private _retryCount: number = 0;
	private _draftMessage: string = '';
	private _receivedResponse: boolean = false;
	private _checkpointCreated: boolean = false;
	/** Tracks if stream_event with text content was received (to skip duplicate final assistant message) */
	private _hasStreamedTextContent: boolean = false;
	/** Tracks if we are currently parsing a <thinking> block in the stream */
	private _isStreamingThinking: boolean = false;
	/** Timestamp when thinking started (for duration calculation) */
	private _thinkingStartTime: Map<string, number> = new Map();
	/** Buffer per stream index for handling partial tags in streaming content */
	private _streamBuffers: Map<number, string> = new Map();
	/** Map of stream index to stable partId for handling fragmented stream events */
	private _activeStreamParts: Map<number, string> = new Map();

	// Message tracking
	private _messageRoles: Map<string, 'user' | 'assistant'> = new Map();
	private _lastPartContent: Map<string, string> = new Map();
	private _pendingAccess: Map<string, { sessionId: string; accessId: string }> = new Map();
	private _lastOpenCodeMessageId: string | undefined;
	/** Track processed message durations to avoid double-counting (for OpenCode) */
	private _processedDurations: Set<string> = new Set();
	/** Track processed API calls to avoid double-counting requestCount (for OpenCode) */
	private _processedApiCalls: Set<string> = new Set();

	/** Track pending task tool IDs waiting for child session context */
	private _pendingTaskToolIds: string[] = [];
	/** Track all task tool IDs that have been created (to avoid duplicate subtask emissions) */
	private _trackedTaskToolIds: Set<string> = new Set();

	// Backup commits (per-session) - integrated from BackupService
	private _commits: CommitInfo[] = [];
	private _changedFiles: ChangedFile[] = [];
	private _backupService: BackupService;

	// Conversation history (per-session) - integrated from ConversationService
	private _conversationMessages: ConversationMessage[] = [];
	private _conversationStartTime: string | undefined;
	private _conversationFilename: string | undefined; // Reference to JSON file for persistence
	private _conversationService: ConversationService;
	// Snapshot of messages before revert (for unrevert functionality)
	private _messagesBeforeRevert: ConversationMessage[] | null = null;

	// Timestamps
	private _createdAt: number = Date.now();
	private _lastActiveAt: number = Date.now();

	// Debounce timer for conversation saves (prevents excessive disk writes during streaming)
	private _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _saveDebounceMs: number = 2000;

	constructor(
		uiSessionId: string,
		private readonly _callbacks: SessionCallbacks,
		context: vscode.ExtensionContext,
	) {
		this.uiSessionId = uiSessionId;
		// Create isolated services for this session
		this._backupService = new BackupService(context);
		this._backupService.setActiveSession(uiSessionId);
		this._conversationService = new ConversationService(context);
	}

	// =========================================================================
	// Getters
	// =========================================================================

	public get createdAt(): number {
		return this._createdAt;
	}

	public get cliSessionId(): string | undefined {
		return this._cliSessionId;
	}

	public get providerType(): 'opencode' | 'claude' | undefined {
		return this._providerType;
	}

	public get isProcessing(): boolean {
		return this._isProcessing;
	}

	public get isAutoRetrying(): boolean {
		return this._isAutoRetrying;
	}

	public get totalCost(): number {
		return this._totalCost;
	}

	public get totalTokensInput(): number {
		return this._mainTokensInput + this._subagentTokensInput;
	}

	public get totalTokensOutput(): number {
		return this._mainTokensOutput + this._subagentTokensOutput;
	}

	/** Tokens used specifically by subagents (not counting towards main context) */
	public get subagentTokensInput(): number {
		return this._subagentTokensInput;
	}

	/** Output tokens used specifically by subagents */
	public get subagentTokensOutput(): number {
		return this._subagentTokensOutput;
	}

	/** Last known context size of the main session (usage.input_tokens) */
	public get mainContextSize(): number {
		return this._lastMainContextSize;
	}

	public get totalReasoningTokens(): number {
		return this._totalReasoningTokens;
	}

	public get totalDuration(): number {
		return this._totalDuration;
	}

	public get requestCount(): number {
		return this._requestCount;
	}

	public get commits(): CommitInfo[] {
		return this._commits;
	}

	public get changedFiles(): ChangedFile[] {
		return this._changedFiles;
	}

	/**
	 * Add a changed file to session tracking
	 */
	public addChangedFile(file: ChangedFile): void {
		// Find by toolUseId first (same edit event), then by filePath without toolUseId
		const existingByToolUseId = this._changedFiles.findIndex(
			f => f.toolUseId && f.toolUseId === file.toolUseId,
		);

		if (existingByToolUseId >= 0) {
			// Same toolUseId - update values (same edit event, e.g. streaming update)
			this._changedFiles[existingByToolUseId] = {
				...this._changedFiles[existingByToolUseId],
				linesAdded: file.linesAdded,
				linesRemoved: file.linesRemoved,
				timestamp: file.timestamp,
			};
		} else {
			// Different toolUseId - add as new entry
			this._changedFiles.push(file);
		}
		this._callbacks.onStateChanged?.(this.uiSessionId);
	}

	/**
	 * Add a commit/checkpoint record to the session.
	 * Used for both git commits and OpenCode-native checkpoints (which may include extra metadata).
	 */
	public addCommit(commit: CommitInfo, options?: { emit?: boolean }): void {
		if (!commit?.sha) return;
		if (this._commits.some(c => c.sha === commit.sha)) return;
		this._commits.push(commit);
		if (options?.emit) {
			this._callbacks.onCommitCreated(this.uiSessionId, commit);
		}
	}

	public get lastActiveAt(): number {
		return this._lastActiveAt;
	}

	public get cliService(): ICLIService | null {
		return this._cliService;
	}

	public get messageRoles(): Map<string, 'user' | 'assistant'> {
		return this._messageRoles;
	}

	public get processedDurations(): Set<string> {
		return this._processedDurations;
	}

	public get processedApiCalls(): Set<string> {
		return this._processedApiCalls;
	}

	/**
	 * Register a task tool that is waiting for a child session context.
	 * When context.created arrives, we pop the oldest pending tool to link it.
	 * Also marks the tool as tracked to prevent duplicate subtask emissions.
	 */
	public pushPendingTaskTool(toolUseId: string): void {
		this._pendingTaskToolIds.push(toolUseId);
		this._trackedTaskToolIds.add(toolUseId);
	}

	/**
	 * Get and remove the oldest pending task tool ID.
	 * Returns undefined if no pending task tools.
	 */
	public popPendingTaskTool(): string | undefined {
		return this._pendingTaskToolIds.shift();
	}

	/**
	 * Check if there are pending task tools waiting for context.
	 */
	public hasPendingTaskTools(): boolean {
		return this._pendingTaskToolIds.length > 0;
	}

	/**
	 * Check if a task tool has already been tracked (subtask created).
	 * Used to prevent duplicate subtask emissions on repeated running events.
	 */
	public isTaskToolTracked(toolUseId: string): boolean {
		return this._trackedTaskToolIds.has(toolUseId);
	}

	public get lastPartContent(): Map<string, string> {
		return this._lastPartContent;
	}

	/** Get the last OpenCode message ID for checkpoint creation */
	public get lastOpenCodeMessageId(): string | undefined {
		return this._lastOpenCodeMessageId;
	}

	/** Set the last OpenCode message ID (used after revert to sync state) */
	public setLastOpenCodeMessageId(messageId: string | undefined): void {
		this._lastOpenCodeMessageId = messageId;
	}

	public get pendingAccess(): Map<string, { sessionId: string; accessId: string }> {
		return this._pendingAccess;
	}

	public get draftMessage(): string {
		return this._draftMessage;
	}

	public get receivedResponse(): boolean {
		return this._receivedResponse;
	}

	public get checkpointCreated(): boolean {
		return this._checkpointCreated;
	}

	public get hasStreamedTextContent(): boolean {
		return this._hasStreamedTextContent;
	}

	public get isStreamingThinking(): boolean {
		return this._isStreamingThinking;
	}

	/** Get current buffered stream content for a given stream index */
	public getStreamBuffer(index: number): string {
		return this._streamBuffers.get(index) || '';
	}

	/** Set buffered stream content for a given stream index */
	public setStreamBuffer(index: number, value: string): void {
		if (!value) {
			this._streamBuffers.delete(index);
			return;
		}
		this._streamBuffers.set(index, value);
	}

	/** Clear buffered stream content for a given stream index */
	public clearStreamBuffer(index: number): void {
		this._streamBuffers.delete(index);
	}

	public get conversationMessages(): ConversationMessage[] {
		return this._conversationMessages;
	}

	// =========================================================================
	// Setters
	// =========================================================================

	public setProcessing(value: boolean): void {
		this._isProcessing = value;
		this._lastActiveAt = Date.now();
	}

	public setAutoRetrying(value: boolean): void {
		if (value) {
			this._retryCount++;
		} else {
			this._retryCount = 0;
		}
		this._isAutoRetrying = value;
		this._lastActiveAt = Date.now();
	}

	public get retryCount(): number {
		return this._retryCount;
	}

	public setDraftMessage(value: string): void {
		this._draftMessage = value;
	}

	public setReceivedResponse(value: boolean): void {
		this._receivedResponse = value;
	}

	public setCheckpointCreated(value: boolean): void {
		this._checkpointCreated = value;
	}

	public setHasStreamedTextContent(value: boolean): void {
		this._hasStreamedTextContent = value;
	}

	public setStreamingThinking(value: boolean): void {
		this._isStreamingThinking = value;
	}

	/** Start tracking thinking duration for a partId */
	public startThinkingTimer(partId: string): void {
		if (!this._thinkingStartTime.has(partId)) {
			this._thinkingStartTime.set(partId, Date.now());
		}
	}

	/** Get thinking duration in ms for a partId, returns 0 if not started */
	public getThinkingDuration(partId: string): number {
		const startTime = this._thinkingStartTime.get(partId);
		if (!startTime) return 0;
		return Date.now() - startTime;
	}

	/** Stop and get final thinking duration for a partId */
	public stopThinkingTimer(partId: string): number {
		const duration = this.getThinkingDuration(partId);
		this._thinkingStartTime.delete(partId);
		return duration;
	}

	/** Clear all thinking timers */
	public clearThinkingTimers(): void {
		this._thinkingStartTime.clear();
	}

	/** Get all active thinking timer part IDs */
	public getActiveThinkingTimers(): string[] {
		return Array.from(this._thinkingStartTime.keys());
	}

	/** Get the start time for a thinking timer (for sending to frontend) */
	public getThinkingStartTime(partId: string): number | undefined {
		return this._thinkingStartTime.get(partId);
	}

	/** Get current active part ID for a stream index */
	public getActiveStreamPart(index: number): string | undefined {
		return this._activeStreamParts.get(index);
	}

	/** Set active part ID for a stream index */
	public setActiveStreamPart(index: number, partId: string): void {
		this._activeStreamParts.set(index, partId);
	}

	/** Clear active part ID for a stream index */
	public clearActiveStreamPart(index: number): void {
		this._activeStreamParts.delete(index);
	}

	public setCLISessionId(value: string | undefined): void {
		this._cliSessionId = value;
	}

	/** Alias for setCLISessionId for consistency */
	public setCliSessionId(value: string | undefined): void {
		this._cliSessionId = value;
	}

	public setProviderType(value: 'opencode' | 'claude' | undefined): void {
		this._providerType = value;
	}

	public markActive(): void {
		this._lastActiveAt = Date.now();
	}

	// =========================================================================
	// CLI Service Management
	// =========================================================================

	/**
	 * Initialize CLI service for this session
	 * Creates a new instance (not shared with other sessions)
	 */
	public async initializeCLIService(
		ServiceClass: new () => ICLIService,
		workspaceRoot?: string,
	): Promise<void> {
		if (this._cliService) return;

		this._cliService = new ServiceClass();
		this._ownsCliService = true;
		await this._cliService.initialize(workspaceRoot);
	}

	/**
	 * Set an existing CLI service (for shared service scenarios)
	 */
	public setCLIService(service: ICLIService): void {
		// Shared services (e.g., OpenCode) must NOT be disposed by individual sessions.
		this._cliService = service;
		this._ownsCliService = false;
	}

	/**
	 * Start a process in this session's CLI service
	 */
	public async startProcess(options: CLIProcessOptions): Promise<void> {
		if (!this._cliService) {
			throw new Error(`Session ${this.uiSessionId}: CLI service not initialized`);
		}

		this._isProcessing = true;
		this._draftMessage = '';
		this._receivedResponse = false;
		this._hasStreamedTextContent = false;
		this._isStreamingThinking = false;
		this._thinkingStartTime.clear();
		this._streamBuffers.clear();
		this._activeStreamParts.clear();
		this._lastPartContent.clear();
		this._lastActiveAt = Date.now();

		// Ensure sessionId is set in options
		// For Claude SDK: use uiSessionId (SDK manages its own CLI session IDs internally)
		// For OpenCode: use _cliSessionId (OpenCode requires its own session ID format)
		const processOptions: CLIProcessOptions = {
			...options,
			sessionId:
				this._cliService?.getProviderType() === 'claude'
					? this.uiSessionId
					: this._cliSessionId || options.sessionId,
		};

		await this._cliService.startProcess(
			processOptions,
			data => {
				// Track OpenCode message IDs for checkpointing.
				// We need to save the LAST COMPLETED assistant message ID from the PREVIOUS turn
				// so that revert(messageID) will roll back TO that message, keeping it and
				// everything before it, while removing the current turn's messages.
				//
				// OpenCode revert semantics: revert(msgID) keeps msgID and everything before it,
				// removes everything after it.
				//
				// We track the user message ID so we can revert TO the assistant message
				// that came before this user message (i.e., the previous turn's final response).
				if (data.type === 'message-update' && data.fullMessage?.id) {
					const role = data.fullMessage.role;
					const msgId = data.fullMessage.id;

					if (role === 'assistant') {
						// Track the latest assistant message ID from this turn.
						// This will be used as the revert target for the NEXT user message's checkpoint.
						logger.debug(`[SessionContext] Tracking assistant message: ${msgId}`);
						this._lastOpenCodeMessageId = msgId;
					}
				}
				this._callbacks.onData(this.uiSessionId, data);
			},
			(code, error) => {
				this._isProcessing = false;
				this._callbacks.onClose(this.uiSessionId, code, error);
			},
			error => {
				this._isProcessing = false;
				this._callbacks.onError(this.uiSessionId, error);
			},
		);
	}

	/**
	 * Stop the running process
	 */
	public stopProcess(): boolean {
		if (!this._cliService) return false;

		const stopped = this._cliService.stopProcess(this._cliSessionId || undefined);
		if (stopped) {
			this._isProcessing = false;
		}
		return stopped;
	}

	/**
	 * Create a new CLI session
	 */
	public async createCLISession(): Promise<string> {
		if (!this._cliService) {
			throw new Error(`Session ${this.uiSessionId}: CLI service not initialized`);
		}

		this._cliSessionId = await this._cliService.createSession();
		// A new OpenCode session has a new message timeline; reset checkpoint pointer.
		this._lastOpenCodeMessageId = undefined;
		return this._cliSessionId;
	}

	// =========================================================================
	// Usage Tracking
	// =========================================================================

	/**
	 * Update token usage from API response
	 * SDK sends cumulative tokens per message, so we track the last known values
	 * and only add the delta to avoid double counting.
	 *
	 * IMPORTANT: OpenCode sends different messages with independent cumulative counters.
	 * Each new messageId has its own token counter starting from 0.
	 * We must reset tracking when messageId changes to avoid incorrect delta calculations.
	 */
	private _lastMessageTokensInput: number = 0;
	private _lastMessageTokensOutput: number = 0;
	private _lastMessageReasoningTokens: number = 0;
	private _lastTokenMessageId: string | undefined;

	public updateTokenUsage(
		usage: TokenUsageAPI,
		messageId?: string,
		isChildSession?: boolean,
	): void {
		const newInput = usage.input_tokens || 0;
		const newOutput = usage.output_tokens || 0;
		const newReasoning = usage.reasoning_tokens || 0;

		// Reset tracking when messageId changes (new message has independent token counter)
		if (messageId && messageId !== this._lastTokenMessageId) {
			this._lastMessageTokensInput = 0;
			this._lastMessageTokensOutput = 0;
			this._lastMessageReasoningTokens = 0;
			this._lastTokenMessageId = messageId;
		}

		// Calculate delta from last known values
		const deltaInput = Math.max(0, newInput - this._lastMessageTokensInput);
		const deltaOutput = Math.max(0, newOutput - this._lastMessageTokensOutput);
		const deltaReasoning = Math.max(0, newReasoning - this._lastMessageReasoningTokens);

		// Update totals based on session type
		if (isChildSession) {
			this._subagentTokensInput += deltaInput;
			this._subagentTokensOutput += deltaOutput;
		} else {
			this._mainTokensInput += deltaInput;
			this._mainTokensOutput += deltaOutput;
			// Track context size only for main session
			this._lastMainContextSize = newInput;
		}

		this._totalReasoningTokens += deltaReasoning;

		// Store current values for next delta calculation
		this._lastMessageTokensInput = newInput;
		this._lastMessageTokensOutput = newOutput;
		this._lastMessageReasoningTokens = newReasoning;
	}

	/**
	 * Reset per-message token tracking (call when starting a new message)
	 */
	public resetMessageTokenTracking(): void {
		this._lastMessageTokensInput = 0;
		this._lastMessageTokensOutput = 0;
		this._lastMessageReasoningTokens = 0;
		this._lastTokenMessageId = undefined;
	}

	/**
	 * Update cost and duration (called on API result - increments request count)
	 */
	public updateStats(cost?: number, duration?: number): void {
		if (cost !== undefined) {
			this._totalCost += cost;
		}
		if (duration !== undefined) {
			this._totalDuration += duration;
		}
		this._requestCount++;
	}

	/**
	 * Add duration only (without incrementing request count)
	 * Used for OpenCode message.updated events where duration comes separately
	 */
	public addDuration(duration: number): void {
		this._totalDuration += duration;
	}

	/**
	 * Increment request count only (for OpenCode API call tracking)
	 */
	public incrementRequestCount(): void {
		this._requestCount++;
	}

	/**
	 * Record a single OpenCode API call by message ID.
	 * Returns `true` when counted for the first time.
	 */
	public recordApiCall(messageId: string): boolean {
		if (!messageId) return false;
		if (this._processedApiCalls.has(messageId)) return false;
		this._processedApiCalls.add(messageId);
		this.incrementRequestCount();
		return true;
	}

	/**
	 * Record duration once per message ID (OpenCode message.updated durationMs).
	 * Returns `true` when counted for the first time.
	 */
	public recordDuration(messageId: string, durationMs: number): boolean {
		if (!messageId) return false;
		if (this._processedDurations.has(messageId)) return false;
		this._processedDurations.add(messageId);
		this.addDuration(durationMs);
		return true;
	}

	/**
	 * Get current stats snapshot
	 */
	public getStats(): {
		totalCost: number;
		totalTokensInput: number;
		totalTokensOutput: number;
		totalReasoningTokens: number;
		totalDuration: number;
		requestCount: number;
	} {
		return {
			totalCost: this._totalCost,
			totalTokensInput: this.totalTokensInput,
			totalTokensOutput: this.totalTokensOutput,
			totalReasoningTokens: this._totalReasoningTokens,
			totalDuration: this._totalDuration,
			requestCount: this._requestCount,
		};
	}

	// =========================================================================
	// Backup Management (integrated from BackupService)
	// =========================================================================

	/**
	 * Create a backup commit before user message
	 */
	public async createBackupCommit(
		userMessage: string,
		associatedMessageId?: string,
	): Promise<CommitInfo | undefined> {
		const commitInfo = await this._backupService.createBackupCommit(
			userMessage,
			associatedMessageId,
		);
		if (commitInfo) {
			this._commits.push(commitInfo);
			this._callbacks.onCommitCreated(this.uiSessionId, commitInfo);
		}
		return commitInfo;
	}

	/**
	 * Restore to a specific commit
	 * Note: Works even if commit is not in our internal list (e.g., after extension reload)
	 */
	public async restoreToCommit(commitSha: string): Promise<{ success: boolean; message: string }> {
		// BackupService now handles validation via git cat-file, so we don't need to check our list
		return await this._backupService.restoreToCommit(commitSha);
	}

	/**
	 * Find commit by SHA
	 */
	public findCommit(sha: string): CommitInfo | undefined {
		return this._commits.find(c => c.sha === sha);
	}

	/**
	 * Clear all commits
	 */
	public clearCommits(): void {
		this._commits = [];
		this._backupService.clearSessionCommits(this.uiSessionId);
	}

	// =========================================================================
	// Conversation Management (integrated from ConversationService)
	// =========================================================================

	/**
	 * Add a message to conversation history.
	 *
	 * Streaming merge logic for 'assistant' and 'thinking' types:
	 * - Uses `partId` (from SDK part.id or CLI content.id) to identify streaming blocks
	 * - Merges updates to the same block (same partId) to avoid storing intermediate updates
	 * - Creates new message when partId differs (different block) or type differs
	 * - Requires `partId` for streaming merge; messages without partId are treated as distinct blocks
	 *
	 * Key insight: if tool_use occurs between two thinking blocks, lastMsg.type will be
	 * 'tool_use' or 'tool_result', so type check naturally prevents incorrect merging.
	 *
	 * For tool_use and access_request, deduplicates by toolUseId/requestId to prevent
	 * duplicates after session restore or repeated SDK events.
	 */
	public addConversationMessage(message: Partial<ConversationMessage> & { type: string }): void {
		if (this._conversationMessages.length === 0) {
			this._conversationStartTime = new Date().toISOString();
		}

		// Deduplicate tool_use by toolUseId
		if (message.type === 'tool_use' && 'toolUseId' in message && message.toolUseId) {
			const existingIdx = this._conversationMessages.findIndex(
				m => m.type === 'tool_use' && 'toolUseId' in m && m.toolUseId === message.toolUseId,
			);
			if (existingIdx !== -1) {
				// Update existing tool_use message
				this._conversationMessages[existingIdx] = {
					...this._conversationMessages[existingIdx],
					...message,
					timestamp: new Date().toISOString(),
				} as ConversationMessage;
				this._debouncedSaveConversation();
				this._callbacks.onStateChanged?.(this.uiSessionId);
				return;
			}
		}

		// Deduplicate access_request by requestId
		if (message.type === 'access_request' && 'requestId' in message && message.requestId) {
			const existingIdx = this._conversationMessages.findIndex(
				m => m.type === 'access_request' && 'requestId' in m && m.requestId === message.requestId,
			);
			if (existingIdx !== -1) {
				// Update existing access_request message (e.g., mark as resolved)
				this._conversationMessages[existingIdx] = {
					...this._conversationMessages[existingIdx],
					...message,
					timestamp: new Date().toISOString(),
				} as ConversationMessage;
				this._debouncedSaveConversation();
				this._callbacks.onStateChanged?.(this.uiSessionId);
				return;
			}
		}

		// Deduplicate subtask by id - update existing subtask status/result
		if (message.type === 'subtask' && message.id) {
			const existingIdx = this._conversationMessages.findIndex(
				m => m.type === 'subtask' && m.id === message.id,
			);
			if (existingIdx !== -1) {
				// Update existing subtask message (e.g., status change from running to completed)
				const existingMsg = this._conversationMessages[existingIdx] as {
					contextId?: string;
				};
				const updateMsg = message as { contextId?: string };
				// Preserve contextId if already linked
				const contextId = existingMsg.contextId || updateMsg.contextId;

				this._conversationMessages[existingIdx] = {
					...this._conversationMessages[existingIdx],
					...message,
					contextId,
					timestamp: new Date().toISOString(),
				} as ConversationMessage;
				this._debouncedSaveConversation();
				this._callbacks.onStateChanged?.(this.uiSessionId);
				return;
			}
		}

		// Fallback deduplication: Check for exact duplicate content for same message ID (if ID provided)
		// This handles race conditions where the same message is added twice
		if (message.id) {
			const messageId = message.id;
			const exactMatch = this._conversationMessages.find(
				m =>
					m.id === messageId &&
					m.type === message.type &&
					JSON.stringify(m) === JSON.stringify({ ...m, ...message }),
			);
			if (exactMatch) {
				return;
			}
		}

		// Streaming message types that should replace the previous message of the same type
		// BUT only if it's the SAME streaming block (identified by partId)
		// If partId differs or there are other messages in between, create a new message
		const streamingTypes = new Set(['assistant', 'thinking']);

		if (streamingTypes.has(message.type) && this._conversationMessages.length > 0) {
			const lastMsg = this._conversationMessages[this._conversationMessages.length - 1];

			// Only merge if last message is the same type (streaming update)
			// Key insight: if there was a tool_use between two thinking blocks,
			// lastMsg.type will be 'tool_use' or 'tool_result', not 'thinking',
			// so the type check naturally prevents incorrect merging.
			if (lastMsg.type !== message.type) {
				// Different type - fall through to add new message
			} else {
				// Merge only if both messages belong to the same streaming block (same partId).
				// If partId differs, treat it as a new block even if type matches.
				const messagePartId = (message as { partId?: string }).partId;
				const lastMsgPartId = (lastMsg as { partId?: string }).partId;

				if (!messagePartId || !lastMsgPartId || messagePartId !== lastMsgPartId) {
					// No partId (invalid) or different partId -> new message
				} else {
					// Check if content property exists (safe access for union types)
					const lastContent = 'content' in lastMsg ? (lastMsg.content as string) : '';
					const msgContent = 'content' in message ? (message.content as string) : '';

					const isDelta = (message as { isDelta?: boolean }).isDelta;
					const newContent = isDelta ? lastContent + msgContent : msgContent || lastContent;

					this._conversationMessages[this._conversationMessages.length - 1] = {
						...lastMsg,
						...message,
						content: newContent,
						id: lastMsg.id, // Keep original ID
						timestamp: new Date().toISOString(),
					} as ConversationMessage;
					this._debouncedSaveConversation();
					this._callbacks.onStateChanged?.(this.uiSessionId);
					return;
				}
			}
		}

		// Add new message
		const newMessage = {
			id: `msg-${Date.now()}-${Math.random()}`,
			timestamp: new Date().toISOString(),
			...message,
		} as ConversationMessage;

		this._conversationMessages.push(newMessage);

		void this._debouncedSaveConversation();

		// Notify SessionManager to persist state to globalState
		this._callbacks.onStateChanged?.(this.uiSessionId);
	}

	/**
	 * Debounced save to prevent excessive disk writes during streaming.
	 * Waits for 2 seconds of inactivity before writing to disk.
	 */
	private _debouncedSaveConversation(): void {
		if (this._saveDebounceTimer) {
			clearTimeout(this._saveDebounceTimer);
		}
		this._saveDebounceTimer = setTimeout(() => {
			this._saveDebounceTimer = null;
			void this.saveConversationWithMetadata();
		}, this._saveDebounceMs);
	}

	/**
	 * Force immediate save, bypassing debounce (used before dispose)
	 */
	private async _flushPendingSave(): Promise<void> {
		if (this._saveDebounceTimer) {
			clearTimeout(this._saveDebounceTimer);
			this._saveDebounceTimer = null;
			await this.saveConversationWithMetadata();
		}
	}

	/**
	 * Clear conversation history
	 */
	public clearConversation(): void {
		this._conversationMessages = [];
		this._conversationStartTime = undefined;
		this._conversationFilename = undefined;
		// Notify SessionManager to persist state
		this._callbacks.onStateChanged?.(this.uiSessionId);
	}

	/**
	 * Remove a specific message from conversation history by ID
	 * Used for dismissing errors/interruptions that shouldn't be persisted
	 */
	public removeConversationMessage(messageId: string): boolean {
		const idx = this._conversationMessages.findIndex(m => m.id === messageId);
		if (idx === -1) return false;

		this._conversationMessages.splice(idx, 1);
		this._debouncedSaveConversation();
		this._callbacks.onStateChanged?.(this.uiSessionId);
		return true;
	}

	/**
	 * Remove all error and interrupted messages from conversation history.
	 * Called when user sends a new message or resumes after interruption.
	 * Returns array of removed message IDs for UI sync.
	 */
	public clearErrorMessages(): string[] {
		const removedIds: string[] = [];
		const originalLength = this._conversationMessages.length;

		this._conversationMessages = this._conversationMessages.filter(m => {
			if (m.type === 'error' || m.type === 'interrupted') {
				if (m.id) removedIds.push(m.id);
				return false;
			}
			return true;
		});

		if (this._conversationMessages.length !== originalLength) {
			this._debouncedSaveConversation();
			this._callbacks.onStateChanged?.(this.uiSessionId);
		}

		return removedIds;
	}

	/**
	 * Replace conversation history with new messages (used after revert/unrevert)
	 * This syncs local state with the authoritative source (e.g., OpenCode server after revert)
	 */
	public replaceConversationMessages(messages: ConversationMessage[]): void {
		this._conversationMessages = [...messages];
		if (messages.length > 0 && !this._conversationStartTime) {
			this._conversationStartTime = messages[0].timestamp || new Date().toISOString();
		}
		// Notify SessionManager to persist state
		this._callbacks.onStateChanged?.(this.uiSessionId);
	}

	/**
	 * Truncate conversation history so it contains messages strictly before the given user message.
	 * This enforces restore semantics: "restore to checkpoint before this message" removes that
	 * user message and anything after it from persisted history.
	 */
	public truncateConversationBeforeUserMessage(userMessageId: string): void {
		if (!userMessageId) return;

		const idx = this._conversationMessages.findIndex(m => {
			if (m.type !== 'user') return false;
			return m.id === userMessageId;
		});

		if (idx === -1) return;

		this._conversationMessages = this._conversationMessages.slice(0, idx);
		if (this._conversationMessages.length === 0) {
			this._conversationStartTime = undefined;
		}
		// Notify SessionManager to persist state
		this._callbacks.onStateChanged?.(this.uiSessionId);
	}

	/**
	 * Truncate conversation history to keep messages up to and including the given message.
	 * This is used for Cursor-style restore: user message stays, assistant responses after it are removed.
	 */
	public truncateConversationAfterMessage(messageId: string): void {
		if (!messageId) return;

		const idx = this._conversationMessages.findIndex(m => m.id === messageId);
		if (idx === -1) return;

		// Save snapshot before truncating (for unrevert)
		this._messagesBeforeRevert = [...this._conversationMessages];

		// Keep messages up to and including the target message
		this._conversationMessages = this._conversationMessages.slice(0, idx + 1);
		// Notify SessionManager to persist state
		this._callbacks.onStateChanged?.(this.uiSessionId);
	}

	/**
	 * Restore messages from snapshot (used by unrevert)
	 * Returns the restored messages or null if no snapshot exists
	 */
	public restoreMessagesFromSnapshot(): ConversationMessage[] | null {
		if (!this._messagesBeforeRevert) return null;

		this._conversationMessages = [...this._messagesBeforeRevert];
		this._messagesBeforeRevert = null;
		// Notify SessionManager to persist state
		this._callbacks.onStateChanged?.(this.uiSessionId);
		return this._conversationMessages;
	}

	/**
	 * Clear the messages snapshot (called after sending a new message)
	 */
	public clearMessagesSnapshot(): void {
		this._messagesBeforeRevert = null;
	}

	/**
	 * Check if there's a messages snapshot available for unrevert
	 */
	public hasMessagesSnapshot(): boolean {
		return this._messagesBeforeRevert !== null;
	}

	/**
	 * Truncate commits so only commits strictly before the given associated user message remain.
	 */
	public truncateCommitsBeforeUserMessage(userMessageId: string): void {
		if (!userMessageId) return;
		const idx = this._commits.findIndex(c => c.associatedMessageId === userMessageId);
		if (idx === -1) return;
		this._commits = this._commits.slice(0, idx);
	}

	/**
	 * Save conversation with metadata
	 * Generates filename only once on first save, then reuses it
	 */
	public async saveConversationWithMetadata(): Promise<void> {
		if (this._conversationMessages.length === 0) return;

		// Generate filename only once - reuse existing if available
		if (!this._conversationFilename) {
			const firstMsg = this._conversationMessages.find(m => m.type === 'user');
			let text = 'conversation';
			if (firstMsg?.type === 'user' && firstMsg.content) {
				text = firstMsg.content;
			}
			const cleanText = text
				.replace(/[^a-zA-Z0-9\s]/g, '')
				.replace(/\s+/g, '-')
				.substring(0, 50)
				.toLowerCase();

			const startTime = this._conversationStartTime || new Date().toISOString();
			const datePrefix = startTime.substring(0, 16).replace('T', '_').replace(/:/g, '-');
			this._conversationFilename = `${datePrefix}_${cleanText}.json`;
		}

		const conversationData: ConversationData = {
			sessionId: this.uiSessionId,
			startTime: this._conversationStartTime,
			endTime: new Date().toISOString(),
			messageCount: this._conversationMessages.length,
			totalCost: this._totalCost,
			totalTokens: {
				input: this.totalTokensInput,
				output: this.totalTokensOutput,
				reasoning: this._totalReasoningTokens,
			},
			totalDuration: this._totalDuration,
			requestCount: this._requestCount,
			messages: this._conversationMessages,
			filename: this._conversationFilename,
		};

		await this._conversationService.saveConversation(conversationData);
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Create a snapshot of session state for persistence
	 * Note: conversationMessages are NOT included to avoid exceeding globalState limits.
	 * Messages are persisted separately in JSON files via ConversationService.
	 */
	public snapshot(): SessionSnapshot {
		return {
			uiSessionId: this.uiSessionId,
			cliSessionId: this._cliSessionId,
			providerType: this._providerType,
			totalCost: this._totalCost,
			totalTokensInput: this.totalTokensInput,
			totalTokensOutput: this.totalTokensOutput,
			totalReasoningTokens: this._totalReasoningTokens,
			totalDuration: this._totalDuration,
			requestCount: this._requestCount,
			isProcessing: this._isProcessing,
			commits: [...this._commits],
			changedFiles: [...this._changedFiles],
			conversationFilename: this._conversationFilename,
			conversationStartTime: this._conversationStartTime,
			lastOpenCodeMessageId: this._lastOpenCodeMessageId,
		};
	}

	/**
	 * Restore session state from snapshot
	 * Note: conversationMessages must be loaded separately via loadConversationFromFile()
	 */
	public restore(snapshot: SessionSnapshot): void {
		this._cliSessionId = snapshot.cliSessionId;
		this._providerType = snapshot.providerType;
		this._totalCost = snapshot.totalCost;
		this._mainTokensInput = snapshot.totalTokensInput; // Snapshot stores total, restore to main + 0 subagent
		this._mainTokensOutput = snapshot.totalTokensOutput;
		this._subagentTokensInput = 0;
		this._subagentTokensOutput = 0;
		this._totalReasoningTokens = snapshot.totalReasoningTokens || 0;
		this._totalDuration = snapshot.totalDuration;
		this._requestCount = snapshot.requestCount;
		// Always reset isProcessing to false on restore - after extension restart,
		// no generation is actually running, so any "processing" state is stale
		this._isProcessing = false;
		this._commits = [...snapshot.commits];
		this._changedFiles = [...(snapshot.changedFiles || [])];
		this._conversationFilename = snapshot.conversationFilename;
		this._conversationStartTime = snapshot.conversationStartTime;
		this._lastOpenCodeMessageId = snapshot.lastOpenCodeMessageId;
		// Messages will be loaded from file when needed via loadConversationFromFile()
	}

	/**
	 * Load conversation messages from JSON file
	 * Called after restore() to hydrate messages from disk
	 * Marks any unresolved access_request messages as resolved since they are stale after reload
	 */
	public async loadConversationFromFile(): Promise<boolean> {
		if (!this._conversationFilename) {
			return false;
		}

		try {
			const data = await this._conversationService.loadConversation(this._conversationFilename);
			if (data?.messages) {
				// Process messages: mark stale access_request as resolved, fix streaming state
				this._conversationMessages = data.messages.map(msg => {
					// Mark all unresolved access_request messages as resolved
					if (msg.type === 'access_request' && !msg.resolved) {
						return { ...msg, resolved: true };
					}
					// Ensure no messages are marked as streaming after reload
					if ('isStreaming' in msg && msg.isStreaming) {
						return { ...msg, isStreaming: false };
					}
					return msg;
				});
				this._conversationStartTime = data.startTime;
				return true;
			}
		} catch (error) {
			// File may not exist or be corrupted - this is not fatal
			console.warn(
				`[SessionContext] Failed to load conversation from ${this._conversationFilename}:`,
				error,
			);
		}
		return false;
	}

	/**
	 * Load session state from saved conversation data (hydration from file)
	 * Used when loading a conversation history from disk
	 * Marks any unresolved access_request messages as resolved since they are stale after reload
	 */
	public loadFromData(data: ConversationData): void {
		// Restore conversation messages, marking stale access_request as resolved
		this._conversationMessages = data.messages
			? data.messages.map(msg => {
					if (msg.type === 'access_request' && !msg.resolved) {
						return { ...msg, resolved: true };
					}
					return msg;
				})
			: [];
		this._conversationStartTime = data.startTime;
		this._conversationFilename = data.filename; // Store filename for persistence

		// Restore stats
		this._totalCost = data.totalCost || 0;
		// Map old persisted totalTokens to mainTokens to maintain continuity
		this._mainTokensInput = data.totalTokens?.input || 0;
		this._mainTokensOutput = data.totalTokens?.output || 0;
		this._subagentTokensInput = 0; // New field, starts at 0 for old sessions
		this._subagentTokensOutput = 0;
		this._totalReasoningTokens = data.totalTokens?.reasoning || 0;
		this._totalDuration = data.totalDuration || 0;
		// requestCount used to be missing in older persisted formats.
		// Using messageCount as a fallback massively inflates "requests" in UI, so derive a more accurate estimate.
		const derivedRequestCount =
			data.requestCount ?? this._conversationMessages.filter(m => m.type === 'user').length ?? 0;
		this._requestCount = derivedRequestCount;

		// CLI session ID from data if available
		if (data.sessionId && !this._cliSessionId) {
			this._cliSessionId = data.sessionId;
		}

		// Reset processing state (loaded sessions are not processing)
		this._isProcessing = false;
		this._receivedResponse = false;
		this._checkpointCreated = false;
		this._hasStreamedTextContent = false;
		this._isStreamingThinking = false;
		this._thinkingStartTime.clear();
		this._streamBuffers.clear();
		this._activeStreamParts.clear();

		// Clear transient state
		this._messageRoles.clear();
		this._processedDurations.clear();
		this._processedApiCalls.clear();
		this._lastPartContent.clear();
		this._pendingAccess.clear();
		this._pendingTaskToolIds = [];
		this._trackedTaskToolIds.clear();
	}

	/**
	 * Clean up session resources
	 */
	public async dispose(): Promise<void> {
		// Flush any pending debounced save before disposing
		await this._flushPendingSave();

		// Stop any running process
		this.stopProcess();

		// Dispose only per-session CLI services. Shared services are disposed by CLIServiceFactory.
		if (this._cliService && this._ownsCliService) {
			await this._cliService.dispose();
		}
		this._cliService = null;
		this._ownsCliService = false;

		// Clear all maps
		this._messageRoles.clear();
		this._processedDurations.clear();
		this._processedApiCalls.clear();
		this._lastPartContent.clear();
		this._pendingAccess.clear();
		this._pendingTaskToolIds = [];
		this._trackedTaskToolIds.clear();
		this._commits = [];
		this._conversationMessages = [];
	}
}
