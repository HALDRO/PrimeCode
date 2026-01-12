/**
 * @file SDKPermissionsBroker
 * @description Bridges Claude Agent SDK tool permission checks (canUseTool) to the extension UI.
 * Applies persisted "always allow" rules from access.json, otherwise emits an access_request
 * through AccessService and awaits the user's decision.
 *
 * Permission check order:
 * 1. Safe tools (read-only) - auto-allowed without prompting
 * 2. Project settings (.claude/settings.json) - user's global policies (Allow All / Ask All)
 * 3. Access.json rules - user's "always allow" choices for specific tools
 * 4. Ask user via UI - for dangerous tools not covered by above rules
 *
 * IMPORTANT: Claude Code CLI by default allows many tools without prompting.
 * We mirror this behavior by auto-allowing "safe" read-only tools that don't modify
 * the filesystem or execute arbitrary code. Only "dangerous" tools require user approval.
 *
 * Safe tools (auto-allowed, read-only operations):
 * - Read/FileRead: Reading files
 * - Glob: Finding files by pattern
 * - Grep: Searching text in files
 * - ListFiles: Listing directory contents
 * - AskUserQuestion: UI interaction (would deadlock if blocked)
 * - ListMcpResources: Listing MCP resources
 * - ReadMcpResource: Reading MCP resources
 * - TaskOutput: Getting task output
 * - WebSearch: Web search (read-only)
 * - TodoRead: Reading TODO list
 *
 * Dangerous tools (require user approval unless allowed by settings):
 * - Bash: Executing shell commands
 * - Edit/FileEdit: Modifying files
 * - Write/FileWrite: Creating/overwriting files
 * - NotebookEdit: Modifying notebooks
 * - WebFetch: Fetching web content (potential security risk)
 * - Agent/Task: Spawning subagents
 * - TodoWrite: Modifying TODO list
 * - Mcp: Calling MCP tools (unknown behavior)
 * - KillShell: Terminating processes
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AccessRequest } from '../../../types';
import { logger } from '../../../utils/logger';
import type { AccessService } from '../../AccessService';

/**
 * Claude settings.json permissions structure
 */
interface ClaudeSettingsPermissions {
	allow?: string[];
	ask?: string[];
	deny?: string[];
}

interface ClaudeSettingsFile {
	permissions?: ClaudeSettingsPermissions;
	[key: string]: unknown;
}

/**
 * Tools that are safe to auto-allow without user confirmation.
 * These are read-only operations that don't modify the filesystem or execute code.
 */
const SAFE_TOOLS = new Set([
	// File reading operations
	'Read',
	'FileRead',
	// File search operations
	'Glob',
	'Grep',
	'ListFiles',
	// UI interaction (would deadlock if blocked)
	'AskUserQuestion',
	// MCP read operations
	'ListMcpResources',
	'ReadMcpResource',
	// Task output (read-only)
	'TaskOutput',
	// Web search (read-only)
	'WebSearch',
	// TODO read (read-only)
	'TodoRead',
]);

/**
 * Mapping from tool names to policy categories used in .claude/settings.json
 * Edit -> edit policy, Bash -> terminal policy, WebFetch -> network policy
 */
const TOOL_TO_POLICY_CATEGORY: Record<string, 'Edit' | 'Bash' | 'WebFetch'> = {
	Edit: 'Edit',
	FileEdit: 'Edit',
	Write: 'Edit',
	FileWrite: 'Edit',
	NotebookEdit: 'Edit',
	Bash: 'Bash',
	WebFetch: 'WebFetch',
};

export class SDKPermissionsBroker {
	private _workspaceRoot: string | undefined;
	private _settingsCache: ClaudeSettingsFile | null = null;
	private _settingsCacheTime = 0;
	private static readonly SETTINGS_CACHE_TTL_MS = 5000; // Cache settings for 5 seconds

	constructor(private readonly _accessService: AccessService) {}

	/**
	 * Set the workspace root for reading .claude/settings.json
	 */
	public setWorkspaceRoot(workspaceRoot: string): void {
		this._workspaceRoot = workspaceRoot;
		// Invalidate cache when workspace changes
		this._settingsCache = null;
		this._settingsCacheTime = 0;
	}

	/**
	 * Returns a session-scoped CanUseTool callback for the Claude SDK.
	 */
	public getToolCallback(sessionId: string): CanUseTool {
		return async (toolName, input, options): Promise<PermissionResult> => {
			const { toolUseID, suggestions } = options;

			logger.debug(`[SDKPermissionsBroker] canUseTool: ${toolName}`, { toolUseID, sessionId });

			// 1) Auto-allow safe read-only tools
			// These tools don't modify the filesystem or execute arbitrary code,
			// so they don't need user confirmation (matches Claude Code CLI default behavior)
			if (SAFE_TOOLS.has(toolName)) {
				logger.debug(`[SDKPermissionsBroker] Auto-allowing safe tool: ${toolName}`);
				return {
					behavior: 'allow',
					updatedInput: input,
					updatedPermissions: suggestions,
				};
			}

			// 2) Check project settings (.claude/settings.json) - user's global policies
			// This handles "Allow All" / "Ask All" settings from the UI
			const settingsPolicy = await this._checkProjectSettings(toolName);
			if (settingsPolicy === 'allow') {
				logger.debug(`[SDKPermissionsBroker] Auto-allowing by project settings: ${toolName}`);
				return {
					behavior: 'allow',
					updatedInput: input,
					updatedPermissions: suggestions,
				};
			}
			if (settingsPolicy === 'deny') {
				logger.debug(`[SDKPermissionsBroker] Denying by project settings: ${toolName}`);
				return {
					behavior: 'deny',
					message: 'Tool denied by project settings (.claude/settings.json)',
				};
			}

			// 3) Auto-allow by persisted access.json rules (user's "always allow" choices)
			const isAllowed = await this._checkAlwaysAllow(toolName, input as Record<string, unknown>);
			if (isAllowed) {
				logger.debug(`[SDKPermissionsBroker] Auto-allowing by access.json rule: ${toolName}`);
				return {
					behavior: 'allow',
					updatedInput: input,
					updatedPermissions: suggestions,
				};
			}

			// 4) Ask user via webview approvals flow for dangerous tools
			const requestId = randomUUID();
			const accessRequest: AccessRequest = {
				id: requestId,
				tool: toolName,
				input: input as Record<string, unknown>,
				toolUseId: toolUseID,
				timestamp: new Date().toISOString(),
				sessionId, // Pass UI session ID for proper routing
			};

			logger.info(`[SDKPermissionsBroker] Requesting approval for ${toolName}`, { requestId });

			const approved = await this._accessService.requestApproval(accessRequest);
			if (approved) {
				return {
					behavior: 'allow',
					updatedInput: input,
					updatedPermissions: suggestions,
				};
			}

			return {
				behavior: 'deny',
				message: 'User denied permission request.',
			};
		};
	}

	/**
	 * Check project settings (.claude/settings.json) for tool permission policy.
	 * Returns 'allow', 'deny', or 'ask' based on the settings.
	 */
	private async _checkProjectSettings(toolName: string): Promise<'allow' | 'deny' | 'ask'> {
		if (!this._workspaceRoot) {
			logger.debug(`[SDKPermissionsBroker] No workspace root set, defaulting to 'ask'`);
			return 'ask';
		}

		try {
			const settings = await this._loadSettings();
			if (!settings?.permissions) {
				logger.debug(
					`[SDKPermissionsBroker] No permissions in settings.json at ${this._workspaceRoot}`,
				);
				return 'ask';
			}

			logger.debug(
				`[SDKPermissionsBroker] Loaded permissions from ${this._workspaceRoot}: ${JSON.stringify(settings.permissions)}`,
			);

			const { allow = [], ask = [], deny = [] } = settings.permissions;

			// Check if tool is in any of the permission lists
			if (deny.includes(toolName)) {
				return 'deny';
			}
			if (allow.includes(toolName)) {
				return 'allow';
			}
			if (ask.includes(toolName)) {
				return 'ask';
			}

			// Also check by policy category (Edit, Bash, WebFetch)
			const category = TOOL_TO_POLICY_CATEGORY[toolName];
			if (category) {
				if (deny.includes(category)) {
					return 'deny';
				}
				if (allow.includes(category)) {
					return 'allow';
				}
				if (ask.includes(category)) {
					return 'ask';
				}
			}

			return 'ask';
		} catch (error) {
			logger.debug(`[SDKPermissionsBroker] Error reading project settings: ${error}`);
			return 'ask';
		}
	}

	/**
	 * Load and cache .claude/settings.json
	 */
	private async _loadSettings(): Promise<ClaudeSettingsFile | null> {
		const now = Date.now();
		if (
			this._settingsCache &&
			now - this._settingsCacheTime < SDKPermissionsBroker.SETTINGS_CACHE_TTL_MS
		) {
			logger.debug(`[SDKPermissionsBroker] Using cached settings`);
			return this._settingsCache;
		}

		if (!this._workspaceRoot) {
			logger.debug(`[SDKPermissionsBroker] _loadSettings: No workspace root`);
			return null;
		}

		const settingsPath = path.join(this._workspaceRoot, '.claude', 'settings.json');
		logger.debug(`[SDKPermissionsBroker] Loading settings from: ${settingsPath}`);

		try {
			const content = await fs.readFile(settingsPath, 'utf8');
			this._settingsCache = JSON.parse(content) as ClaudeSettingsFile;
			this._settingsCacheTime = now;
			logger.debug(
				`[SDKPermissionsBroker] Successfully loaded settings: ${JSON.stringify(this._settingsCache)}`,
			);
			return this._settingsCache;
		} catch (error) {
			// File doesn't exist or is invalid - that's OK
			logger.debug(`[SDKPermissionsBroker] Failed to load settings: ${error}`);
			this._settingsCache = null;
			this._settingsCacheTime = now;
			return null;
		}
	}

	private async _checkAlwaysAllow(
		toolName: string,
		input: Record<string, unknown>,
	): Promise<boolean> {
		const access = await this._accessService.getAccess();
		const rule = access.alwaysAllow[toolName];

		if (!rule) return false;
		if (rule === true) return true;

		if (Array.isArray(rule) && toolName === 'Bash' && typeof input.command === 'string') {
			const pattern = this._accessService.getCommandPattern(input.command);
			return rule.includes(pattern);
		}

		return false;
	}
}
