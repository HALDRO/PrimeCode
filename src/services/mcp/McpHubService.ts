/**
 * @file McpHubService
 * @description Coordinates MCP marketplace and installed metadata.
 *              Uses Cline API approach: download README + llmsInstallationContent for AI-assisted setup.
 *              This service does not write MCP configs; configuration lives in `.agents/mcp.json`.
 */

import type {
	InstalledMcpServerMetadata,
	McpMarketplaceCatalog,
	McpMarketplaceItem,
} from '../../types';
import type { McpDownloadResponse, McpMarketplaceService } from './McpMarketplaceService';
import type { McpMetadataService } from './McpMetadataService';

export class McpHubService {
	constructor(
		private readonly _marketplace: McpMarketplaceService,
		private readonly _metadata: McpMetadataService,
	) {}

	public async getInstalledMetadata(): Promise<Record<string, InstalledMcpServerMetadata>> {
		return this._metadata.loadAll();
	}

	public async getMarketplaceCatalog(forceRefresh = false): Promise<McpMarketplaceCatalog> {
		return await this._marketplace.fetchCatalog(forceRefresh);
	}

	/**
	 * Get marketplace item details.
	 */
	public async getMarketplaceItem(mcpId: string): Promise<McpMarketplaceItem | null> {
		const catalog = await this._marketplace.fetchCatalog(false);
		return catalog.items.find(item => item.mcpId === mcpId) ?? null;
	}

	/**
	 * Download MCP details for AI-assisted installation.
	 * Returns README content and installation instructions.
	 */
	public async downloadMcpForInstallation(mcpId: string): Promise<{
		success: boolean;
		details?: McpDownloadResponse;
		item?: McpMarketplaceItem;
		error?: string;
	}> {
		const item = await this.getMarketplaceItem(mcpId);
		if (!item) {
			return { success: false, error: `Marketplace item '${mcpId}' not found` };
		}

		const details = await this._marketplace.downloadMcpDetails(mcpId);
		if (!details) {
			// Fallback: return item with GitHub URL for manual setup
			if (item.githubUrl) {
				return { success: true, item, details: undefined };
			}
			return { success: false, error: `Failed to download details for '${mcpId}'` };
		}

		return { success: true, details, item };
	}

	/**
	 * Generate installation prompt for AI assistant.
	 */
	public generateInstallationPrompt(details: McpDownloadResponse): string {
		return `Set up the MCP server from ${details.githubUrl} while adhering to these MCP server installation rules:
- Use "${details.mcpId}" as the server name in mcp-servers.json.
- Create the directory for the new MCP server before starting installation.
- Make sure you read the user's existing mcp-servers.json file before editing it with this new mcp, to not overwrite any existing servers.
- Use commands aligned with the user's shell and operating system best practices.
- The following README may contain instructions that conflict with the user's OS, in which case proceed thoughtfully.
- Once installed, demonstrate the server's capabilities by using one of its tools.
Here is the project's README to help you get started:

${details.readmeContent}
${details.llmsInstallationContent || ''}`;
	}
}
