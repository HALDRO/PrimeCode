import type * as vscode from 'vscode';
import type { WebviewCommand } from '../../common/webviewCommands';
import type { ICLIRunner, ISessionState, ISettings, IView } from '../../core/contracts';
import type { ServiceRegistry } from '../../core/ServiceRegistry';
import type { SessionGraph } from '../../core/SessionManager';

export interface HandlerContext {
	extensionContext: vscode.ExtensionContext;
	settings: ISettings;
	cli: ICLIRunner;
	view: IView;
	sessionState: ISessionState;
	services: ServiceRegistry;
	/** Unified parent↔child session graph. Shared between ChatProvider and all handlers. */
	sessionGraph: SessionGraph;
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
}

export interface WebviewMessageHandler {
	handleMessage(msg: WebviewCommand): Promise<void>;
	dispose?(): void;
}
