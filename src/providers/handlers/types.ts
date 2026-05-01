import type * as vscode from 'vscode';
import type {
	PermissionCategory,
	PermissionPolicies,
	PermissionPolicyValue,
} from '../../common/permissions';
import type { WebviewCommand } from '../../common/protocol';
import type { ISettings } from '../../core/contracts';
import type { OpenCodeExecutor } from '../../core/executor/OpenCode';
import type { ServiceRegistry } from '../../core/ServiceRegistry';
import type { OutboundBridge } from '../../transport/OutboundBridge';

export interface HandlerContext {
	extensionContext: vscode.ExtensionContext;
	settings: ISettings;
	cli: OpenCodeExecutor;
	/** Typed outbound bridge for sending messages to webview. */
	bridge: OutboundBridge;
	services: ServiceRegistry;
	/** Returns current permission policies from ToolHandler. */
	getPermissionPolicies?: () => PermissionPolicies;
	/** Applies a permission policy through ToolHandler so in-memory, storage, and project config stay in sync. */
	setPermissionPolicy?: (
		category: PermissionCategory,
		policy: PermissionPolicyValue,
	) => Promise<void>;
	/** Returns whether runtime auto-accept is enabled for a session. */
	getSessionAutoAccept?: (sessionId: string) => Promise<boolean>;
	/** Returns effective + explicit permission auto-accept state for a session. */
	getSessionAutoAcceptState?: (sessionId: string) => {
		mode: 'default' | 'on' | 'off';
		effective: boolean;
	};
	/** Returns the direct parent session id when known. */
	getParentSessionId?: (sessionId: string) => Promise<string | undefined>;
	/** Clears runtime auto-accept state for a session. */
	clearSessionAutoAccept?: (sessionId: string) => void;
	/** Refresh webview bootstrap after a successful manual server restart. */
	refreshAfterServerRestart?: () => Promise<void>;
	/** Hot-reload OpenCode runtime state so config/resources are re-read without killing the process. */
	reloadOpenCodeRuntime?: (source: string) => Promise<void>;
}

export interface WebviewMessageHandler {
	handleMessage(msg: WebviewCommand): Promise<void>;
	dispose?(): void;
}
