/**
 * @file Proxy Service Exports
 * @description Exports for the proxy server module
 */

// ProxyServerService removed - converters dependency deleted

export interface ProxyConfig {
	targetBaseUrl: string;
	apiKey: string;
	localPort?: number;
	modelMapping?: Record<string, string>;
}

export interface ProxyServerInfo {
	url: string;
	port: number;
	baseUrl: string;
}

export function getProxyServer(): {
	getInfo(): ProxyServerInfo | null;
	start(config: ProxyConfig): Promise<ProxyServerInfo>;
	stop(): Promise<void>;
	isRunning(): boolean;
} | null {
	return null;
}

export class ProxyServerService {
	// Stub for compatibility
}
