/**
 * @file storeState.ts
 * @description Centralized store state factories grouped by domain.
 *
 * This keeps the main `chatStore.ts` focused on orchestration and actions,
 * while the state shape stays readable in one place instead of tiny slice files.
 */

import type {
	Message,
	Part,
	PermissionRequest,
	QuestionRequest,
	Session,
	SessionStatus,
	SnapshotFileDiff,
	Todo,
} from '@opencode-ai/sdk/v2/client';
import type { QueuedMessageData } from '../../common/protocol';
import type { MaterializedView } from './projector';

export interface MessageDomainState {
	messages: Record<string, Message[]>;
	parts: Record<string, Part[]>;
	sessionStatus: Record<string, SessionStatus>;
	sessionDiff: Record<string, SnapshotFileDiff[]>;
	todos: Record<string, Todo[]>;
	permissions: Record<string, PermissionRequest[]>;
	questions: Record<string, QuestionRequest[]>;
	lastError: { sessionID: string; error: unknown } | null;
	materializedViews: Record<string, MaterializedView>;
}

export interface DraftDomainState {
	editingMessageId: string | null;
	editDrafts: Record<string, string>;
	sessionInput: Record<string, string>;
	draftAttachments: Record<
		string,
		{ files?: string[]; images?: unknown[]; codeSnippets?: unknown[] }
	>;
	draftAgent: Record<string, string | undefined>;
	isImprovingPrompt: boolean;
	improvingPromptRequestId: string | null;
	promptVersions: { original: string; improved: string; showingImproved: boolean } | null;
}

export interface SessionMetaDomainState {
	sessions: Session[];
	activeSessionId: string | undefined;
	sessionOrder: string[];
	childSessionIdsByParentId: Record<string, string[]>;
	originatingToolCallBySessionId: Record<string, string>;
	queuedMessages: Record<string, QueuedMessageData[]>;
	sessionAgent: Record<string, string | undefined>;
	sessionModel: Record<string, string | undefined>;
	sessionAutoAccept: Record<string, boolean>;
}

export function createMessageDomainState(): MessageDomainState {
	return {
		messages: {},
		parts: {},
		sessionStatus: {},
		sessionDiff: {},
		todos: {},
		permissions: {},
		questions: {},
		lastError: null,
		materializedViews: {},
	};
}

export function createDraftDomainState(): DraftDomainState {
	return {
		editingMessageId: null,
		editDrafts: {},
		sessionInput: {},
		draftAttachments: {},
		draftAgent: {},
		isImprovingPrompt: false,
		improvingPromptRequestId: null,
		promptVersions: null,
	};
}

export function createSessionMetaDomainState(): SessionMetaDomainState {
	return {
		sessions: [],
		activeSessionId: undefined,
		sessionOrder: [],
		childSessionIdsByParentId: {},
		originatingToolCallBySessionId: {},
		queuedMessages: {},
		sessionAgent: {},
		sessionModel: {},
		sessionAutoAccept: {},
	};
}
