/**
 * @file Common exports
 * @description Single entry point for values/types shared between extension and webview.
 */

export * from './constants';
// Avoid name collisions (Rule / ParsedCommand) between schemas and extensionMessages.
export type {
	AccessRequestData,
	AccessResponseData,
	ExtensionMessage,
	Rule,
	SessionAccessPayload,
	SessionAuthPayload,
	SessionCompletePayload,
	SessionDeleteMessagesAfterPayload,
	SessionEventMessage,
	SessionEventPayload,
	SessionEventType,
	SessionFilePayload,
	SessionInfoData,
	SessionLifecycleAction,
	SessionLifecycleMessage,
	SessionMessageData,
	SessionMessagePayload,
	SessionMessageRemovedPayload,
	SessionMessagesReloadPayload,
	SessionMessageType,
	SessionRestorePayload,
	SessionStatsPayload,
	SessionStatus,
	SessionStatusPayload,
	SessionTerminalPayload,
	ToolResultData,
	ToolUseData,
} from './extensionMessages';
export * from './schemas';
export * from './webviewCommands';

/** Generate a unique ID with the given prefix: `{prefix}-{timestamp}-{random}` */
export function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
