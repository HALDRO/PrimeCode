import type * as vscode from 'vscode';
import type { ICLIRunner, ISessionState, ISettings, IView } from '../../core/contracts';
import type { ServiceRegistry } from '../../core/ServiceRegistry';

export interface WebviewMessage {
	type: string;
	[key: string]: unknown;
}

export interface HandlerContext {
	extensionContext: vscode.ExtensionContext;
	settings: ISettings;
	cli: ICLIRunner;
	view: IView;
	sessionState: ISessionState;
	services: ServiceRegistry;
}

export interface WebviewMessageHandler {
	handleMessage(msg: WebviewMessage): Promise<void>;
	dispose?(): void;
}
