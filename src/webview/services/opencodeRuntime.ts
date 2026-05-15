import {
	createOpencodeClient,
	type Message,
	type OpencodeClient,
	type Part,
	type PermissionRequest,
	type QuestionRequest,
	type Session,
	type SessionStatus,
	type SnapshotFileDiff,
	type Todo,
} from '@opencode-ai/sdk/v2/client';
import { produce } from 'immer';
import { type ConversationIndexEntry, generateId, parseModelId } from '../../common';
import { IMPROVE_PROMPT_DEFAULT_TEMPLATE } from '../../common/promptImprover';
import {
	collectSessionSubtreeIds,
	getProcessingSessionIds,
	getSessionRuntimeStatus,
	type SessionStore,
	useChatStore,
} from '../store/chatStore';
import { clearSessionViewCache } from '../store/derived';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { webviewLogger } from '../utils/logger';
import { proxyFetch } from '../utils/proxyFetch';
import { vscode } from '../utils/vscode';

const log = webviewLogger.forComponent('OpenCodeRuntime');

type RestorableSession = Session & {
	lastModified?: number;
	created?: number;
};

export type SessionMessageEntry = {
	info: Message;
	parts: Part[];
};

const SKIP_PARTS = new Set(['patch', 'step-start', 'step-finish', 'snapshot']);

let cachedUrl: string | null = null;
let cachedRoot = '';
let cachedClient: OpencodeClient | null = null;
let improvePromptController: AbortController | null = null;
let improvePromptRequestId: string | null = null;
const pendingStatusRechecks = new Map<string, number>();

function normalizeDriveLetter(dir: string): string {
	return dir.length >= 2 && dir[1] === ':' ? dir[0].toUpperCase() + dir.slice(1) : dir;
}

function getWorkspaceRoot(): string {
	const workspaceRoot = useUIStore.getState().workspaceRoot ?? '';
	if (!workspaceRoot) {
		throw new Error('Workspace root is unavailable');
	}
	return normalizeDriveLetter(workspaceRoot);
}

function getServerUrl(): string {
	const serverUrl = useUIStore.getState().serverUrl;
	if (!serverUrl) {
		throw new Error('OpenCode server is unavailable');
	}
	return serverUrl;
}

function getClient(): OpencodeClient {
	const serverUrl = getServerUrl();
	const workspaceRoot = getWorkspaceRoot();
	if (!cachedClient || cachedUrl !== serverUrl || cachedRoot !== workspaceRoot) {
		cachedUrl = serverUrl;
		cachedRoot = workspaceRoot;
		cachedClient = createOpencodeClient({
			baseUrl: serverUrl,
			directory: workspaceRoot,
			fetch: proxyFetch,
		});
	}
	return cachedClient;
}

function getPermissionListsClient() {
	return getClient() as OpencodeClient & {
		permission?: {
			list?: (params: { sessionID: string; directory: string }) => Promise<{
				data?: PermissionRequest[];
				error?: unknown;
			}>;
		};
		question?: {
			list?: (params: { sessionID: string; directory: string }) => Promise<{
				data?: QuestionRequest[];
				error?: unknown;
			}>;
		};
		session: OpencodeClient['session'] & {
			status?: (params: { directory: string }) => Promise<{
				data?: Record<string, { type?: string }>;
				error?: unknown;
			}>;
		};
	};
}

async function haltSessionIfBusy(sessionId: string): Promise<void> {
	const processingSessionIds = getProcessingSessionIds(useChatStore.getState(), sessionId);
	if (processingSessionIds.length === 0) return;
	await Promise.all(
		processingSessionIds.map(async processingSessionId => {
			await getClient()
				.session.abort({ sessionID: processingSessionId, directory: getWorkspaceRoot() })
				.catch(() => {
					// Best effort only. Revert/restore should still continue even if abort fails.
				});
		}),
	);
}

function applyLocalRevertState(sessionId: string, revert: { messageID: string } | undefined): void {
	useChatStore.setState(
		produce((state: SessionStore) => {
			const sessionIndex = state.sessions.findIndex(session => session.id === sessionId);
			if (sessionIndex >= 0) {
				state.sessions[sessionIndex] = {
					...state.sessions[sessionIndex],
					revert,
				};
			}
		}),
	);
}

function throwRuntimeClientError(error: unknown): never {
	if (isConfigError(error)) {
		throw new Error(formatConfigError(error));
	}
	if (isServerError(error)) {
		throw new Error(error.data?.message ?? error.name);
	}
	throw error instanceof Error ? error : new Error(String(error));
}

function assertRuntimeResult(result: { error?: unknown } | undefined): void {
	if (!result?.error) return;
	throwRuntimeClientError(result.error);
}

type RuntimeAttachments = {
	files?: string[];
	codeSnippets?: Array<{
		filePath: string;
		content: string;
		startLine?: number;
		endLine?: number;
	}>;
	images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
};

type RuntimeSendParams = {
	sessionId: string;
	text: string;
	messageID?: string;
	model?: string;
	agent?: string;
	variant?: string;
	attachments?: RuntimeAttachments;
};

function isSessionActive(sessionId: string): boolean {
	const status = getSessionRuntimeStatus(useChatStore.getState(), sessionId);
	return status?.type === 'busy' || status?.type === 'retry';
}

async function dispatchMessage(params: RuntimeSendParams): Promise<void> {
	vscode.postMessage({
		type: 'sendMessage',
		sessionId: params.sessionId,
		text: params.text,
		messageID: params.messageID,
		model: params.model,
		agent: params.agent,
		variant: params.variant,
		attachments: params.attachments,
	});
}

async function flushQueuedMessages(sessionId: string): Promise<void> {
	if (isSessionActive(sessionId)) return;
	const entry = useChatStore.getState().actions.dequeueMessage(sessionId);
	if (!entry) return;
	try {
		await dispatchMessage({
			sessionId: entry.sessionId,
			text: entry.text,
			messageID: entry.messageId,
			model: entry.model,
			agent: entry.agent,
			variant: entry.variant,
			attachments: entry.attachments,
		});
	} catch (error) {
		useChatStore.getState().actions.prependQueuedMessage(sessionId, entry);
		throw error;
	}
}

function scheduleBusyStatusRecheck(sessionIds: string[], delayMs: number): void {
	for (const sessionId of sessionIds) {
		const status = getSessionRuntimeStatus(useChatStore.getState(), sessionId);
		// Skip sessions already confirmed idle — no need to recheck them.
		// Sessions with busy/retry OR undefined status (not yet confirmed) get rechecked.
		if (status?.type === 'idle') continue;

		const existing = pendingStatusRechecks.get(sessionId);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}

		const timeout = window.setTimeout(() => {
			pendingStatusRechecks.delete(sessionId);
			const currentStatus = getSessionRuntimeStatus(useChatStore.getState(), sessionId);
			if (currentStatus?.type !== 'busy' && currentStatus?.type !== 'retry') return;
			void openCodeRuntime.refreshRuntimeState(sessionId).catch(() => {
				// Best-effort resync only. Normal live events remain the primary source of truth.
			});
		}, delayMs);

		pendingStatusRechecks.set(sessionId, timeout);
	}
}

async function deleteMessagesFrom(sessionId: string, messageId: string): Promise<void> {
	const messages = useChatStore.getState().messages[sessionId] ?? [];
	const startIndex = messages.findIndex(message => message.id === messageId);
	const messageIds =
		startIndex >= 0
			? messages
					.slice(startIndex)
					.map(message => message.id)
					.reverse()
			: [messageId];

	for (let index = 0; index < messageIds.length; index += 5) {
		const chunk = messageIds.slice(index, index + 5);
		await Promise.all(
			chunk.map(async id => {
				const url = new URL(`${getServerUrl()}/session/${sessionId}/message/${id}`);
				url.searchParams.set('directory', getWorkspaceRoot());
				const response = await proxyFetch(url.toString(), { method: 'DELETE' });
				if (!response.ok && response.status !== 404) {
					const bodyText = await response.text().catch(() => '');
					throw new Error(
						`Message delete failed: ${response.status} ${response.statusText}${bodyText ? `\n${bodyText}` : ''}`,
					);
				}
			}),
		);
	}
}

interface ServerError {
	name: string;
	data?: {
		path?: string;
		message?: string;
		issues?: Array<{ message: string; path: string[] }>;
	};
}

function isServerError(error: unknown): error is ServerError {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		typeof (error as ServerError).name === 'string'
	);
}

function isConfigError(error: unknown): error is ServerError {
	return isServerError(error) && error.name === 'ConfigInvalidError';
}

function formatConfigError(error: ServerError): string {
	const data = error.data;
	if (!data) return 'Invalid configuration';
	const file = data.path ?? 'opencode.json';
	const issues = (data.issues ?? [])
		.map(issue => {
			if (!issue.path.length) return issue.message;
			return `${issue.path.join('.')}: ${issue.message}`;
		})
		.filter(Boolean);
	const detail = issues.length ? issues.join('; ') : (data.message ?? '');
	return detail ? `Config error in ${file}: ${detail}` : `Invalid config at ${file}`;
}

function getRuntimeErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name || 'OpenCode request failed';
	if (typeof error === 'string' && error.trim()) return error.trim();
	if (!error || typeof error !== 'object') return 'OpenCode request failed';
	const record = error as Record<string, unknown>;
	if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
	const data = record.data;
	if (data && typeof data === 'object') {
		const dataMessage = (data as Record<string, unknown>).message;
		if (typeof dataMessage === 'string' && dataMessage.trim()) return dataMessage.trim();
	}
	return 'OpenCode request failed';
}

function shouldSuppressRuntimeErrorNotification(error: unknown, message: string): boolean {
	const lowerMessage = message.toLowerCase();
	const name =
		typeof error === 'object' &&
		error !== null &&
		typeof (error as { name?: unknown }).name === 'string'
			? ((error as { name: string }).name || '').toLowerCase()
			: '';
	if (name === 'messageabortederror') return true;
	if (name !== 'unknownerror') return false;
	if (lowerMessage.includes('agent not found')) return true;
	return (
		lowerMessage.includes('sessionprompt.createusermessage') &&
		lowerMessage.includes('unknownerror: unknownerror')
	);
}

function showRuntimeError(error: unknown): void {
	const message = getRuntimeErrorMessage(error);
	const suppressNotification = shouldSuppressRuntimeErrorNotification(error, message);
	log.error('Runtime error', {
		error: message,
		suppressNotification,
		stack: error instanceof Error ? error.stack : undefined,
	});
	if (suppressNotification) return;
	useUIStore.getState().actions.pushNotification({
		type: 'error',
		content: message,
		timestamp: new Date().toISOString(),
		autoDismissMs: 8000,
	});
}

function getResolvedPromptImproveTemplate(): string {
	const template = useSettingsStore.getState().promptImproveTemplate;
	return typeof template === 'string' && template.trim()
		? template
		: IMPROVE_PROMPT_DEFAULT_TEMPLATE;
}

function getResolvedPromptImproveModel(): string | undefined {
	const improveModel = useSettingsStore.getState().promptImproveModel;
	if (typeof improveModel === 'string' && improveModel.trim()) {
		return improveModel;
	}
	const activeSessionId = useChatStore.getState().activeSessionId;
	return activeSessionId ? useChatStore.getState().sessionModel[activeSessionId] : undefined;
}

async function runPromptImprove(text: string, signal: AbortSignal): Promise<string> {
	const template = getResolvedPromptImproveTemplate();
	if (!template.trim()) {
		throw new Error(
			'Prompt Improver template is empty. Configure it in Settings -> Prompt Improver.',
		);
	}

	const fullText = template.includes('{{TEXT}}')
		? template.replace('{{TEXT}}', text)
		: `${template.trim()}\n\n---\n\n${text}`;
	const client = getClient();
	const directory = getWorkspaceRoot();
	const parsedModel = parseModelId(getResolvedPromptImproveModel() ?? '');
	const created = await client.session.create({ directory });
	if (created.error || !created.data?.id) {
		throw new Error(`Failed to create temp session: ${created.error ?? 'no session id'}`);
	}

	const tempSessionId = created.data.id;
	try {
		const result = await client.session.prompt(
			{
				sessionID: tempSessionId,
				directory,
				parts: [{ type: 'text', text: fullText }],
				...(parsedModel
					? { model: { providerID: parsedModel.providerId, modelID: parsedModel.modelId } }
					: {}),
			},
			{ signal },
		);
		if (result.error) {
			throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
		}
		const response = result.data as { parts?: Array<{ type: string; text?: string }> } | undefined;
		const improvedText = (response?.parts ?? [])
			.filter(part => part.type === 'text' && typeof part.text === 'string')
			.map(part => part.text ?? '')
			.join('')
			.trim();
		if (!improvedText) {
			throw new Error('Empty response from model');
		}
		return improvedText;
	} finally {
		void client.session.delete({ sessionID: tempSessionId, directory }).catch(() => {});
	}
}

function toConversationEntry(session: RestorableSession): ConversationIndexEntry {
	const createdAt = Number(session.time?.created ?? session.created ?? Date.now());
	const updatedAt = Number(session.time?.updated ?? session.lastModified ?? createdAt);
	const title = typeof session.title === 'string' ? session.title : '';
	return {
		filename: session.id,
		sessionId: session.id,
		startTime: new Date(createdAt).toISOString(),
		endTime: new Date(updatedAt).toISOString(),
		messageCount: 0,
		totalCost: 0,
		firstUserMessage: title || 'Untitled',
		lastUserMessage: title || '',
		customTitle: title || undefined,
	};
}

function persistTabs(): void {
	const { sessions, sessionOrder, activeSessionId } = useChatStore.getState();
	const childSessionIds = new Set(
		sessions.filter(session => Boolean(session.parentID)).map(session => session.id),
	);
	const openTabs = sessionOrder.filter(sessionId => !childSessionIds.has(sessionId));
	const activeTab =
		activeSessionId && openTabs.includes(activeSessionId) ? activeSessionId : openTabs.at(-1);
	const previous = (window.vscode?.getState() as Record<string, unknown> | undefined) ?? {};
	window.vscode?.setState({
		...previous,
		openTabs,
		activeTab,
	});
}

function closeTabState(state: SessionStore, sessionId: string): void {
	delete state.sessionInput[sessionId];
	delete state.sessionAgent[sessionId];
	delete state.sessionModel[sessionId];
	delete state.sessionAutoAccept[sessionId];
	delete state.draftAttachments[sessionId];
	delete state.draftAgent[sessionId];
	delete state.childSessionIdsByParentId[sessionId];
	delete state.originatingToolCallBySessionId[sessionId];
	delete state.messages[sessionId];
	delete state.sessionStatus[sessionId];
	delete state.sessionDiff[sessionId];
	delete state.sessionOwnedFiles[sessionId];
	delete state.todos[sessionId];
	delete state.permissions[sessionId];
	delete state.questions[sessionId];
	state.sessions = state.sessions.filter(session => session.id !== sessionId);
	for (const [messageId, parts] of Object.entries(state.parts)) {
		if (parts.some(part => part.sessionID === sessionId)) {
			delete state.parts[messageId];
		}
	}
	clearSessionViewCache(sessionId);
}

async function collectSessionSubtree(
	client: OpencodeClient,
	workspaceRoot: string,
	rootSession: RestorableSession,
): Promise<RestorableSession[]> {
	const sessions: RestorableSession[] = [rootSession];
	const queue: RestorableSession[] = [rootSession];
	const seen = new Set<string>([rootSession.id]);

	let head = 0;
	while (head < queue.length) {
		const current = queue[head++];
		const result = await client.session
			.children({ sessionID: current.id, directory: workspaceRoot })
			.catch(() => ({ data: [] }));
		for (const child of (result.data ?? []) as RestorableSession[]) {
			if (!child.id || seen.has(child.id)) continue;
			seen.add(child.id);
			sessions.push(child);
			queue.push(child);
		}
	}

	return sessions;
}

function getLastVisibleUserMessageId(messageEntries: SessionMessageEntry[]): string | undefined {
	for (let index = messageEntries.length - 1; index >= 0; index--) {
		const message = messageEntries[index]?.info;
		if (message?.role === 'user') return message.id;
	}
	return undefined;
}

async function hydrateSession(sessionId: string, activate = true): Promise<void> {
	const client = getClient();
	const workspaceRoot = getWorkspaceRoot();
	const [sessionResult, todoResult] = await Promise.all([
		client.session.get({ sessionID: sessionId, directory: workspaceRoot }),
		client.session
			.todo({ sessionID: sessionId, directory: workspaceRoot })
			.catch(() => ({ data: [] })),
	]);

	if (sessionResult.error || !sessionResult.data) {
		log.error('hydrateSession: SDK returned error', {
			sessionId,
			error: sessionResult.error,
			hasData: !!sessionResult.data,
			serverUrl: cachedUrl,
			workspaceRoot,
		});
		throw new Error(`Failed to load session ${sessionId}`);
	}

	const session = sessionResult.data as RestorableSession;
	const subtreeSessions = await collectSessionSubtree(client, workspaceRoot, session);
	const messagesBySession = await Promise.all(
		subtreeSessions.map(async currentSession => {
			const messagesResult = await client.session.messages({
				sessionID: currentSession.id,
				directory: workspaceRoot,
			});
			const messageEntries = (messagesResult.data ?? []) as SessionMessageEntry[];
			const lastVisibleUserMessageId = getLastVisibleUserMessageId(messageEntries);
			const diffResult = await client.session
				.diff({
					sessionID: currentSession.id,
					directory: workspaceRoot,
					messageID: lastVisibleUserMessageId,
				})
				.catch(() => ({ data: [] }));
			return {
				session: currentSession,
				messageEntries,
				diff: ((diffResult.data ?? []) as SnapshotFileDiff[]) || [],
			};
		}),
	);
	const todos = ((todoResult.data ?? []) as Todo[]) || [];
	useChatStore.getState().actions.replaySessionSnapshots(
		messagesBySession.map(({ session: currentSession, messageEntries, diff }) => ({
			session: currentSession,
			messageEntries: messageEntries.map(entry => ({
				info: entry.info,
				parts: entry.parts.filter(part => !SKIP_PARTS.has(part.type)),
			})),
			todos: currentSession.id === session.id ? todos : [],
			diff,
			activate: currentSession.id === session.id ? activate : false,
		})),
	);
	await openCodeRuntime.refreshRuntimeState(
		session.id,
		subtreeSessions.map(currentSession => currentSession.id),
	);
	scheduleBusyStatusRecheck(
		subtreeSessions.map(currentSession => currentSession.id),
		3000,
	);
}

async function refreshConversationList(): Promise<void> {
	const client = getClient();
	const workspaceRoot = getWorkspaceRoot();
	const result = await client.experimental.session.list({
		directory: workspaceRoot,
		archived: false,
		limit: 200,
	});
	if (result.error) {
		log.warn('refreshConversationList: SDK returned error', {
			error: result.error,
			serverUrl: cachedUrl,
			workspaceRoot,
		});
		if (isConfigError(result.error)) {
			throw result.error;
		}
	}
	const sessions = ((result.data ?? []) as RestorableSession[]).filter(
		session => session.id && !session.parentID,
	);
	const hydrated = await Promise.all(
		sessions.map(async session => {
			try {
				const messagesResult = await client.session.messages({
					sessionID: session.id,
					directory: workspaceRoot,
					limit: 1,
				});
				const hasMessages = Array.isArray(messagesResult.data) && messagesResult.data.length > 0;
				return hasMessages ? toConversationEntry(session) : null;
			} catch {
				return null;
			}
		}),
	);
	useUIStore
		.getState()
		.actions.setConversationList(
			hydrated.filter((entry): entry is ConversationIndexEntry => entry !== null),
		);
}

async function reconcileOpenSessions(): Promise<void> {
	const state = useChatStore.getState();
	const sessionIds = [...new Set(state.sessionOrder)];

	await refreshConversationList();
	await Promise.all(
		sessionIds.map(async sessionId => {
			if (!sessionId) return;
			try {
				await hydrateSession(sessionId, sessionId === state.activeSessionId);
			} catch (error: unknown) {
				log.warn('Reconcile: failed to hydrate session', {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	);
}

export const openCodeRuntime = {
	showRuntimeError,
	persistTabs,
	refreshConversationList,
	reconcileOpenSessions,

	async bootstrap(): Promise<void> {
		try {
			await refreshConversationList();
		} catch (error: unknown) {
			if (isConfigError(error)) {
				const msg = formatConfigError(error as ServerError);
				log.error('Bootstrap blocked by invalid project config', { error: msg });
				useUIStore.getState().actions.pushNotification({
					type: 'error',
					content: msg,
					timestamp: new Date().toISOString(),
				});
				return;
			}
			showRuntimeError(error);
			return;
		}

		try {
			const persisted =
				(window.vscode?.getState() as { openTabs?: string[]; activeTab?: string } | undefined) ??
				{};
			if (persisted.openTabs?.length) {
				for (const sessionId of persisted.openTabs) {
					try {
						await hydrateSession(sessionId, sessionId === persisted.activeTab);
					} catch (error: unknown) {
						log.warn('Bootstrap: failed to hydrate persisted tab', {
							sessionId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				if (useChatStore.getState().sessionOrder.length > 0) {
					persistTabs();
					return;
				}
			}
			const firstConversation = useUIStore.getState().conversationList[0];
			if (firstConversation?.sessionId) {
				await hydrateSession(firstConversation.sessionId, true);
				persistTabs();
				return;
			}
			await this.createSession();
		} catch (error) {
			showRuntimeError(error);
		}
	},

	async refreshRuntimeState(sessionId: string, sessionIds?: string[]): Promise<void> {
		const client = getPermissionListsClient();
		const directory = getWorkspaceRoot();
		const [statusResult, permissionResult, questionResult] = await Promise.all([
			client.session.status?.({ directory }).catch(() => null),
			client.permission?.list?.({ sessionID: sessionId, directory }).catch(() => null),
			client.question?.list?.({ sessionID: sessionId, directory }).catch(() => null),
		]);
		const relevantSessionIds = new Set(sessionIds?.filter(Boolean) ?? [sessionId]);
		const statusMap =
			statusResult?.data && typeof statusResult.data === 'object'
				? (statusResult.data as Record<string, SessionStatus | undefined>)
				: {};

		useChatStore.setState(
			produce((state: SessionStore) => {
				for (const targetSessionId of relevantSessionIds) {
					const status = statusMap[targetSessionId];
					if (status) {
						state.sessionStatus[targetSessionId] = status;
						continue;
					}
					// Server omits idle sessions from the status map (they are deleted on transition to idle).
					// Always reset to idle here — the old guard `if (!(id in state.sessionStatus))` caused
					// stale "busy" status to persist indefinitely after reconnect or abort.
					state.sessionStatus[targetSessionId] = { type: 'idle' };
				}
				state.permissions[sessionId] = [...(permissionResult?.data ?? [])];
				state.questions[sessionId] = [...(questionResult?.data ?? [])];
			}),
		);
	},

	async autoRespondPendingPermissions(sessionId: string): Promise<void> {
		if (!sessionId) return;
		const state = useChatStore.getState();
		const autoAccept = state.sessionAutoAccept[sessionId] ?? false;
		const accessAutoApprove = useSettingsStore.getState().accessAutoApprove;
		if (!autoAccept && !accessAutoApprove) return;

		await this.refreshRuntimeState(sessionId);
		const pending = useChatStore.getState().permissions[sessionId] ?? [];
		if (pending.length === 0) return;

		const { policies, access } = useSettingsStore.getState();
		const alwaysAllowByTool = new Set(
			(access ?? []).filter(entry => entry.allowAll).map(entry => entry.toolName.toLowerCase()),
		);

		for (const request of pending) {
			const permissionName = request.permission?.toLowerCase?.() ?? '';
			const shouldApprove =
				accessAutoApprove ||
				autoAccept ||
				alwaysAllowByTool.has(permissionName) ||
				policies[permissionName as keyof typeof policies] === 'allow';
			const shouldDeny = policies[permissionName as keyof typeof policies] === 'deny';
			if (!shouldApprove && !shouldDeny) continue;

			await this.respondToPermission({
				requestId: request.id,
				toolName: request.permission,
				approved: shouldApprove,
				alwaysAllow: false,
				response: shouldApprove ? 'once' : 'reject',
			});
		}
	},

	async respondToPermission(params: {
		requestId: string;
		toolName?: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void> {
		const client = getClient();
		const reply =
			params.response ?? (params.approved ? (params.alwaysAllow ? 'always' : 'once') : 'reject');
		const permissionClient = client as OpencodeClient & {
			permission?: {
				reply?: (input: {
					requestID: string;
					reply: 'once' | 'always' | 'reject';
				}) => Promise<{ error?: unknown }>;
			};
		};
		if (permissionClient.permission?.reply) {
			const result = await permissionClient.permission.reply({
				requestID: params.requestId,
				reply,
			});
			if (result?.error) {
				throw new Error(`Permission response failed: ${JSON.stringify(result.error)}`);
			}
			return;
		}
		throw new Error('Permission reply API unavailable in webview runtime');
	},

	async respondToQuestion(params: { requestId: string; answers: string[][] }): Promise<void> {
		const client = getClient() as OpencodeClient & {
			question?: {
				reply?: (input: { requestID: string; answers: string[][] }) => Promise<{ error?: unknown }>;
			};
		};
		if (!client.question?.reply) {
			throw new Error('Question reply API unavailable in webview runtime');
		}
		const result = await client.question.reply({
			requestID: params.requestId,
			answers: params.answers,
		});
		if (result?.error) {
			throw new Error(`Question reply failed: ${JSON.stringify(result.error)}`);
		}
	},

	async rejectQuestion(requestId: string): Promise<void> {
		const client = getClient() as OpencodeClient & {
			question?: {
				reject?: (input: { requestID: string }) => Promise<{ error?: unknown }>;
			};
		};
		if (!client.question?.reject) {
			throw new Error('Question reject API unavailable in webview runtime');
		}
		const result = await client.question.reject({ requestID: requestId });
		if (result?.error) {
			throw new Error(`Question reject failed: ${JSON.stringify(result.error)}`);
		}
	},

	async createSession(): Promise<string> {
		const client = getClient();
		const workspaceRoot = getWorkspaceRoot();
		const result = await client.session.create({ directory: workspaceRoot });
		if (result.error || !result.data) {
			log.error('createSession: SDK returned error', {
				error: result.error,
				hasData: !!result.data,
				serverUrl: cachedUrl,
				workspaceRoot,
			});
			throw new Error('Failed to create session');
		}
		const session = result.data as Session;
		useChatStore.setState(
			produce((state: SessionStore) => {
				const index = state.sessions.findIndex(item => item.id === session.id);
				if (index >= 0) state.sessions[index] = session;
				else state.sessions.push(session);
				if (!state.sessionOrder.includes(session.id)) {
					state.sessionOrder.push(session.id);
				}
				state.activeSessionId = session.id;
			}),
		);
		persistTabs();
		await hydrateSession(session.id, true);
		await refreshConversationList();
		return session.id;
	},

	switchSession(sessionId: string): void {
		useChatStore.setState({ activeSessionId: sessionId });
		persistTabs();
		const state = useChatStore.getState();
		if (!state.messages[sessionId]) {
			void hydrateSession(sessionId, true).catch(showRuntimeError);
		}
	},

	closeSession(sessionId: string): void {
		useChatStore.setState(
			produce((state: SessionStore) => {
				state.sessionOrder = state.sessionOrder.filter(id => id !== sessionId);
				closeTabState(state, sessionId);
				if (state.activeSessionId === sessionId) {
					state.activeSessionId = state.sessionOrder[state.sessionOrder.length - 1];
				}
			}),
		);
		persistTabs();
	},

	async loadConversation(sessionId: string): Promise<void> {
		await hydrateSession(sessionId, true);
		persistTabs();
	},

	async renameConversation(sessionId: string, newTitle: string): Promise<void> {
		const client = getClient();
		await client.session.update({
			sessionID: sessionId,
			directory: getWorkspaceRoot(),
			title: newTitle,
		});
		await refreshConversationList();
		if (useChatStore.getState().activeSessionId === sessionId) {
			await hydrateSession(sessionId, true);
		}
	},

	async deleteConversation(sessionId: string): Promise<void> {
		const client = getClient();
		await client.session.delete({ sessionID: sessionId, directory: getWorkspaceRoot() });
		this.closeSession(sessionId);
		await refreshConversationList();
	},

	async clearAllConversations(): Promise<void> {
		const client = getClient();
		const workspaceRoot = getWorkspaceRoot();
		const result = await client.experimental.session.list({
			directory: workspaceRoot,
			archived: false,
			limit: 500,
		});
		const sessions = (result.data ?? []) as RestorableSession[];
		await Promise.all(
			sessions.map(session =>
				client.session.delete({ sessionID: session.id, directory: workspaceRoot }),
			),
		);
		useChatStore.setState(
			produce((state: SessionStore) => {
				for (const sessionId of [...state.sessionOrder]) {
					closeTabState(state, sessionId);
				}
				state.sessionOrder = [];
				state.activeSessionId = undefined;
			}),
		);
		persistTabs();
		await refreshConversationList();
	},

	async abortSession(sessionId: string): Promise<void> {
		// Always abort the requested session — the server handles child propagation via task tool abort listeners.
		// Additionally abort any known processing children for faster cancellation.
		const state = useChatStore.getState();
		const processingChildren = getProcessingSessionIds(state, sessionId).filter(
			id => id !== sessionId,
		);
		const abortTargets = [sessionId, ...processingChildren];
		await Promise.all(
			abortTargets.map(currentSessionId =>
				getClient()
					.session.abort({ sessionID: currentSessionId, directory: getWorkspaceRoot() })
					.catch(() => {}),
			),
		);
		// Schedule status recheck for the ENTIRE subtree — not just currently-busy children.
		// After reconnect/hydration, children may have stale "busy" status that the server
		// has already cleared. The recheck will reconcile UI state with the server.
		const allSubtreeIds = collectSessionSubtreeIds(state, sessionId);
		scheduleBusyStatusRecheck(allSubtreeIds, 2000);
	},

	async restoreMessage(sessionId: string, messageId: string): Promise<void> {
		const client = getClient();
		await haltSessionIfBusy(sessionId);
		const result = await client.session.revert({
			sessionID: sessionId,
			messageID: messageId,
			directory: getWorkspaceRoot(),
		});
		assertRuntimeResult(result);
		applyLocalRevertState(sessionId, { messageID: messageId });
	},

	async unrevert(sessionId: string): Promise<void> {
		const client = getClient();
		await haltSessionIfBusy(sessionId);
		const result = await client.session.unrevert({
			sessionID: sessionId,
			directory: getWorkspaceRoot(),
		});
		assertRuntimeResult(result);
		applyLocalRevertState(sessionId, undefined);
	},

	async editMessage(params: {
		sessionId: string;
		messageId: string;
		text: string;
		mode: 'restore_and_send' | 'replace_history';
		isAlreadyReverted: boolean;
		model?: string;
		attachments?: {
			files?: string[];
			codeSnippets?: Array<{
				filePath: string;
				content: string;
				startLine?: number;
				endLine?: number;
			}>;
			images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
		};
		agent?: string;
		variant?: string;
	}): Promise<void> {
		await haltSessionIfBusy(params.sessionId);
		const shouldUseRevertFlow = params.isAlreadyReverted || params.mode === 'restore_and_send';

		log.info('Editing message history', {
			sessionId: params.sessionId,
			messageId: params.messageId,
			mode: params.mode,
			isAlreadyReverted: params.isAlreadyReverted,
			strategy: shouldUseRevertFlow ? 'revert-flow' : 'delete-flow',
		});

		if (params.isAlreadyReverted && params.mode === 'replace_history') {
			log.info('Promoting replace_history to revert-flow for already reverted session', {
				sessionId: params.sessionId,
				messageId: params.messageId,
			});
		}

		if (!params.isAlreadyReverted && params.mode === 'restore_and_send') {
			const result = await getClient().session.revert({
				sessionID: params.sessionId,
				messageID: params.messageId,
				directory: getWorkspaceRoot(),
			});
			assertRuntimeResult(result);
			applyLocalRevertState(params.sessionId, { messageID: params.messageId });
		}

		if (!shouldUseRevertFlow) {
			await deleteMessagesFrom(params.sessionId, params.messageId);
			useChatStore
				.getState()
				.actions.truncateSessionMessages(params.sessionId, params.messageId, true);
			applyLocalRevertState(params.sessionId, undefined);
		}

		await this.sendMessage({
			sessionId: params.sessionId,
			text: params.text,
			messageID: generateId('msg'),
			model: params.model,
			agent: params.agent,
			variant: params.variant,
			attachments: params.attachments,
		});
	},

	async improvePrompt(text: string, requestId: string): Promise<void> {
		if (!text.trim() || !requestId) {
			throw new Error('Missing text or requestId');
		}

		improvePromptController?.abort();
		improvePromptController = new AbortController();
		improvePromptRequestId = requestId;
		const timeout = window.setTimeout(() => improvePromptController?.abort(), 30_000);

		try {
			const improvedText = await runPromptImprove(text, improvePromptController.signal);
			if (improvePromptRequestId !== requestId) return;
			const activeSessionId = useChatStore.getState().activeSessionId;
			const currentInput = activeSessionId
				? useChatStore.getState().sessionInput[activeSessionId] || ''
				: '';
			useChatStore.setState(
				produce((state: SessionStore) => {
					state.promptVersions = {
						original: currentInput,
						improved: improvedText,
						showingImproved: true,
					};
					state.isImprovingPrompt = false;
					state.improvingPromptRequestId = null;
					if (activeSessionId) {
						state.sessionInput[activeSessionId] = improvedText;
					}
				}),
			);
		} catch (error) {
			if (improvePromptRequestId !== requestId) return;
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message.toLowerCase().includes('abort');
			useChatStore.setState({ isImprovingPrompt: false, improvingPromptRequestId: null });
			if (!aborted) {
				useUIStore.getState().actions.pushNotification({
					type: 'error',
					content: `Prompt Improve failed\n${message || 'Unknown error'}`,
					timestamp: new Date().toISOString(),
					autoDismissMs: 8000,
				});
			}
		} finally {
			window.clearTimeout(timeout);
			if (improvePromptRequestId === requestId) {
				improvePromptRequestId = null;
				improvePromptController = null;
			}
		}
	},

	cancelImprovePrompt(requestId?: string): void {
		if (requestId && improvePromptRequestId !== requestId) {
			return;
		}
		improvePromptController?.abort();
		improvePromptController = null;
		improvePromptRequestId = null;
		useChatStore.setState({ isImprovingPrompt: false, improvingPromptRequestId: null });
	},

	async sendMessage(params: RuntimeSendParams): Promise<void> {
		if (isSessionActive(params.sessionId)) {
			useChatStore.getState().actions.enqueueMessage({
				sessionId: params.sessionId,
				text: params.text,
				messageId: params.messageID,
				attachments: params.attachments,
				agent: params.agent,
				model: params.model,
				variant: params.variant,
			});
			return;
		}

		await dispatchMessage(params);
	},

	async flushQueuedMessages(sessionId: string): Promise<void> {
		await flushQueuedMessages(sessionId);
	},

	async cancelQueuedMessage(sessionId: string, queueId: string): Promise<void> {
		useChatStore.getState().actions.cancelQueuedMessage(sessionId, queueId);
	},

	async reorderQueuedMessages(sessionId: string, queueIds: string[]): Promise<void> {
		useChatStore.getState().actions.reorderQueuedMessages(sessionId, queueIds);
	},

	async forceSendQueuedMessage(sessionId: string, queueId: string): Promise<void> {
		const queue = useChatStore.getState().queuedMessagesBySession[sessionId] ?? [];
		const queueIndex = queue.findIndex(entry => entry.queueId === queueId);
		if (queueIndex === -1) return;
		if (queueIndex > 0) {
			const ids = queue.map(item => item.queueId);
			const [moved] = ids.splice(queueIndex, 1);
			ids.unshift(moved);
			useChatStore.getState().actions.reorderQueuedMessages(sessionId, ids);
		}

		if (isSessionActive(sessionId)) {
			await this.abortSession(sessionId).catch(() => {});
			return;
		}

		await flushQueuedMessages(sessionId);
	},
};
