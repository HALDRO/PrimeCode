import type * as vscode from 'vscode';
import type { PermissionPolicies } from '../../common/permissions';
import type { WebviewCommand } from '../../common/protocol';
import type { ISessionState, ISettings } from '../../core/contracts';
import type { OpenCodeExecutor } from '../../core/executor/OpenCode';
import type { ServiceRegistry } from '../../core/ServiceRegistry';
import type { SessionGraph } from '../../core/SessionManager';
import type { OutboundBridge } from '../../transport/OutboundBridge';

export interface HandlerContext {
	extensionContext: vscode.ExtensionContext;
	settings: ISettings;
	cli: OpenCodeExecutor;
	/** Typed outbound bridge for sending messages to webview. */
	bridge: OutboundBridge;
	sessionState: ISessionState;
	services: ServiceRegistry;
	/** Unified parent↔child session graph. Shared between ChatProvider and all handlers. */
	sessionGraph: SessionGraph;
	/** Returns current permission policies from ToolHandler. Used by SessionHandler for reconnect. */
	getPermissionPolicies?: () => PermissionPolicies;
	/** Returns whether runtime auto-accept is enabled for a session. */
	getSessionAutoAccept?: (sessionId: string) => boolean;
	/** Clears runtime auto-accept state for a session. */
	clearSessionAutoAccept?: (sessionId: string) => void;
	/** Register a checkpoint on the backend so the frontend can restore by commitId alone. */
	registerCheckpoint?: (
		commitId: string,
		record: {
			sessionId: string;
			messageId: string;
			associatedMessageId: string;
			isOpenCode: boolean;
		},
	) => void;
	/** Clean up restore/revert state when a session is deleted. */
	cleanupSessionRestore?: (sessionId: string) => void;
}

export interface WebviewMessageHandler {
	handleMessage(msg: WebviewCommand): Promise<void>;
	dispose?(): void;
}
