/**
 * @file CopyActions - header copy button with dropdown menu
 * @description Provides copy-to-clipboard actions for chat content and diffs.
 *              Lives in the Header, left of the connection status indicator.
 *              "Copy All History" collects messages + diffs (git-patch) + task results from child sessions.
 *              "Copy All Messages" copies only text content of messages.
 *              Also exports helpers for per-section copy used in the chat area.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { extractCanonicalTaskResult } from '../../../common';
import { buildToolActionType } from '../../../common/normalizedTypes';
import { isFileEditTool, isMcpTool, isToolMatch } from '../../constants';
import { cn } from '../../lib/cn';
import { deriveSessionView, type RenderNode, useMcpServers } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { copyTextToClipboard } from '../../utils/clipboard';
import { resolveFileChanges } from '../chat/SimpleDiff';
import { CopyIcon } from '../icons';
import { DropdownMenu, IconButton } from '../ui';

interface CopyMenuItem {
	label: string;
	action: () => void;
}

// ─── Shared helpers ───

function getActiveMessages(): RenderNode[] | undefined {
	const state = useChatStore.getState();
	const sid = state.activeSessionId;
	if (!sid) return undefined;
	const mcpServerNames = Object.keys(useSettingsStore.getState().mcpServers || {});
	const view = deriveSessionView(state, sid, mcpServerNames);
	if (!view || view.nodeIds.length === 0) return undefined;
	const items: RenderNode[] = [];
	for (const id of view.nodeIds) {
		const node = view.nodesById[id];
		if (node) items.push(node);
	}
	return items.length > 0 ? items : undefined;
}

/** Check if a tool_use should be included in copy output (MCP, WebSearch, WebFetch) */
function isCopyableToolResult(m: RenderNode, mcpServerNames: string[]): boolean {
	if (m.kind !== 'tool_use') return false;
	const name = m.toolName?.toLowerCase() ?? '';
	if (name === 'websearch' || name === 'webfetch') return true;
	return isMcpTool(m.toolName, mcpServerNames);
}

function formatMessage(m: RenderNode, mcpServerNames: string[]): string | undefined {
	if (m.kind === 'user') {
		const text = m.parts
			.filter(p => p.type === 'text' && 'text' in p)
			.map(p => ('text' in p ? (p as { text: string }).text : ''))
			.join('');
		return `## User\n${text}`;
	}
	if (m.kind === 'assistant' && m.content) {
		return `## Assistant\n${m.content}`;
	}
	if (m.kind === 'task_card') {
		const parts: string[] = [];
		if (m.result) {
			const result = extractCanonicalTaskResult(m.result).trim();
			if (!result) return undefined;
			parts.push(`## Agent: ${m.agent ?? 'SubAgent'}\n${result}`);
		}
		return parts.length > 0 ? parts.join('\n\n') : undefined;
	}
	// Include completed tool output from MCP, WebSearch, WebFetch
	if (m.kind === 'tool_use' && isCopyableToolResult(m, mcpServerNames)) {
		const toolName = m.toolName ?? 'Tool';
		const content = (() => {
			const state = useChatStore.getState();
			for (const messageParts of Object.values(state.parts)) {
				for (const part of messageParts) {
					if (part.type !== 'tool') continue;
					const toolPart = part as import('@opencode-ai/sdk/v2/client').ToolPart;
					if (toolPart.callID !== m.toolUseId) continue;
					if ('output' in toolPart.state) return toolPart.state.output ?? '';
					return '';
				}
			}
			return '';
		})();
		if (!content.trim()) return undefined;
		return `## ${toolName}\n${content}`;
	}
	return undefined;
}

function formatMessages(msgs: RenderNode[], mcpServerNames: string[]): string {
	const parts: string[] = [];
	for (const m of msgs) {
		const text = formatMessage(m, mcpServerNames);
		if (text) parts.push(text);
	}
	return parts.join('\n\n');
}

/**
 * Collect git-patch-format diffs from tool parts for given message IDs.
 * If no messageIds provided, collects from all assistant messages in the active session.
 */
export function collectDiffsAsGitPatch(messageIds?: Set<string>): string {
	const state = useChatStore.getState();
	const sid = state.activeSessionId;
	if (!sid) return '';

	const messages = state.messages[sid];
	if (!messages || messages.length === 0) return '';

	const targetMessageIds =
		messageIds ?? new Set(messages.filter(m => m.role === 'assistant').map(m => m.id));

	if (targetMessageIds.size === 0) return '';

	const patches: string[] = [];

	for (const msgId of targetMessageIds) {
		const messageParts = state.parts[msgId];
		if (!messageParts) continue;

		for (const part of messageParts) {
			if (part.type !== 'tool') continue;
			const tp = part as import('@opencode-ai/sdk/v2/client').ToolPart;
			const toolName = tp.tool ?? '';

			// Only process file-edit / apply-patch tools
			const isEdit = isFileEditTool(toolName);
			const isPatch = isToolMatch(toolName, 'apply_patch');
			if (!isEdit && !isPatch) continue;

			const rawInput =
				'input' in tp.state && tp.state.input && typeof tp.state.input === 'object'
					? (tp.state.input as Record<string, unknown>)
					: {};
			const metadata =
				tp.metadata ??
				('metadata' in tp.state
					? (tp.state as { metadata?: Record<string, unknown> }).metadata
					: undefined);

			if (!metadata) continue;

			const actionType = buildToolActionType(toolName, rawInput);
			const fileChanges = resolveFileChanges({
				actionType,
				toolResultMetadata: metadata,
				fallbackFilePath:
					typeof rawInput.file_path === 'string'
						? rawInput.file_path
						: typeof rawInput.path === 'string'
							? rawInput.path
							: undefined,
			});

			for (const change of fileChanges) {
				if (!change.diffText.trim()) continue;
				patches.push(`${change.filePath}\n${change.diffText.trim()}`);
			}
		}
	}

	return patches.join('\n\n');
}

/**
 * Build "Copy All History" content: all messages + all diffs + task results from child sessions.
 * This is the comprehensive copy that includes everything from the main session.
 */
function buildAllHistory(mcpServerNames: string[]): string {
	const state = useChatStore.getState();
	const sid = state.activeSessionId;
	if (!sid) return '';

	const msgs = getActiveMessages();
	if (!msgs) return '';

	const sections: string[] = [];

	// Collect all text messages (includes task_card results from child sessions)
	const messagesText = formatMessages(msgs, mcpServerNames);
	if (messagesText) sections.push(messagesText);

	// Collect all diffs from the session
	const diffs = collectDiffsAsGitPatch();
	if (diffs) sections.push(`## Diffs\n\n${diffs}`);

	return sections.join('\n\n---\n\n');
}

// ─── Components ───

const CopyDropdown = React.memo<{
	items: CopyMenuItem[];
	onClose: () => void;
}>(({ items, onClose }) => (
	<DropdownMenu
		items={items.map((item, idx) => ({
			id: `copy-${idx}`,
			label: item.label,
			data: item,
		}))}
		onSelect={(item: CopyMenuItem) => {
			item.action();
			onClose();
		}}
		onClose={onClose}
		position="bottom"
		align="right"
		minWidth={180}
		maxWidth={220}
		keyHints={{}}
	/>
));
CopyDropdown.displayName = 'CopyDropdown';

function useCopyMenuItems(): CopyMenuItem[] {
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

	const handleCopyAllHistory = useCallback(() => {
		const text = buildAllHistory(mcpServerNames);
		if (text) void copyTextToClipboard(text);
	}, [mcpServerNames]);

	const handleCopyAllMessages = useCallback(() => {
		const msgs = getActiveMessages();
		if (!msgs) return;
		const text = formatMessages(msgs, mcpServerNames);
		if (text) void copyTextToClipboard(text);
	}, [mcpServerNames]);

	return useMemo<CopyMenuItem[]>(
		() => [
			{ label: 'Copy All History', action: handleCopyAllHistory },
			{ label: 'Copy All Messages', action: handleCopyAllMessages },
		],
		[handleCopyAllHistory, handleCopyAllMessages],
	);
}

export const CopyActionsButton: React.FC<{ className?: string; noBackground?: boolean }> =
	React.memo(({ className, noBackground }) => {
		const [showCopyDropdown, setShowCopyDropdown] = useState(false);
		const copyMenuItems = useCopyMenuItems();

		return (
			<div className={cn('relative', className)}>
				{showCopyDropdown && (
					<CopyDropdown items={copyMenuItems} onClose={() => setShowCopyDropdown(false)} />
				)}
				<IconButton
					icon={<CopyIcon size={12} />}
					onClick={e => {
						e.stopPropagation();
						setShowCopyDropdown(prev => !prev);
					}}
					title="Copy options"
					size={20}
					className={noBackground ? 'bg-transparent hover:bg-transparent' : undefined}
				/>
			</div>
		);
	});
CopyActionsButton.displayName = 'CopyActionsButton';

// ─── Per-section copy (used in chat message sections) ───

/**
 * Flatten GroupedResponseItem[] into a flat RenderNode array.
 */
function flattenResponses(responses: (RenderNode | RenderNode[])[]): RenderNode[] {
	const flat: RenderNode[] = [];
	for (const item of responses) {
		if (Array.isArray(item)) {
			flat.push(...item);
		} else {
			flat.push(item);
		}
	}
	return flat;
}

/**
 * Collect diffs for a specific set of tool_use IDs from the store.
 * Scans all parts to find matching ToolParts and resolves their file changes.
 */
function collectDiffsForToolUseIds(toolUseIds: Set<string>): string {
	if (toolUseIds.size === 0) return '';
	const state = useChatStore.getState();
	const patches: string[] = [];

	for (const messageParts of Object.values(state.parts)) {
		for (const part of messageParts) {
			if (part.type !== 'tool') continue;
			const tp = part as import('@opencode-ai/sdk/v2/client').ToolPart;
			if (!toolUseIds.has(tp.callID)) continue;

			const toolName = tp.tool ?? '';
			const isEdit = isFileEditTool(toolName);
			const isPatch = isToolMatch(toolName, 'apply_patch');
			if (!isEdit && !isPatch) continue;

			const rawInput =
				'input' in tp.state && tp.state.input && typeof tp.state.input === 'object'
					? (tp.state.input as Record<string, unknown>)
					: {};
			const metadata =
				tp.metadata ??
				('metadata' in tp.state
					? (tp.state as { metadata?: Record<string, unknown> }).metadata
					: undefined);

			if (!metadata) continue;

			const actionType = buildToolActionType(toolName, rawInput);
			const fileChanges = resolveFileChanges({
				actionType,
				toolResultMetadata: metadata,
				fallbackFilePath:
					typeof rawInput.file_path === 'string'
						? rawInput.file_path
						: typeof rawInput.path === 'string'
							? rawInput.path
							: undefined,
			});

			for (const change of fileChanges) {
				if (!change.diffText.trim()) continue;
				patches.push(`${change.filePath}\n${change.diffText.trim()}`);
			}
		}
	}

	return patches.join('\n\n');
}

/**
 * Build copy text for a single section's response: assistant text + task results only (no diffs).
 */
export function buildSectionResponseText(
	responses: (RenderNode | RenderNode[])[],
	mcpServerNames: string[],
): string {
	const flat = flattenResponses(responses);
	const sections: string[] = [];

	// Collect text content and task results only
	for (const m of flat) {
		if (m.kind === 'assistant' && m.content) {
			sections.push(m.content);
		}
		if (m.kind === 'task_card' && m.result) {
			const result = extractCanonicalTaskResult(m.result).trim();
			if (result) sections.push(`[${m.agent ?? 'SubAgent'}] ${result}`);
		}
		if (m.kind === 'tool_use' && isCopyableToolResult(m, mcpServerNames)) {
			const content = (() => {
				const state = useChatStore.getState();
				for (const messageParts of Object.values(state.parts)) {
					for (const part of messageParts) {
						if (part.type !== 'tool') continue;
						const toolPart = part as import('@opencode-ai/sdk/v2/client').ToolPart;
						if (toolPart.callID !== m.toolUseId) continue;
						if ('output' in toolPart.state) return toolPart.state.output ?? '';
						return '';
					}
				}
				return '';
			})();
			if (content.trim()) sections.push(content);
		}
	}

	return sections.join('\n\n');
}

/**
 * Build copy text for only the diffs in a section.
 */
export function buildSectionDiffsText(responses: (RenderNode | RenderNode[])[]): string {
	const flat = flattenResponses(responses);

	const toolUseIds = new Set<string>();
	for (const m of flat) {
		if (m.kind === 'tool_use') {
			toolUseIds.add(m.toolUseId);
		}
	}

	return collectDiffsForToolUseIds(toolUseIds);
}

export interface SectionCopyButtonProps {
	responses: (RenderNode | RenderNode[])[];
	userMessage?: RenderNode;
}

export const SectionCopyButton: React.FC<SectionCopyButtonProps> = React.memo(
	({ responses, userMessage }) => {
		const mcpServers = useMcpServers();
		const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
		const [showDropdown, setShowDropdown] = useState(false);

		const handleCopyTurn = useCallback(() => {
			const parts: string[] = [];
			// Include user message text
			if (userMessage && userMessage.kind === 'user') {
				const text = userMessage.parts
					.filter(p => p.type === 'text' && 'text' in p)
					.map(p => ('text' in p ? (p as { text: string }).text : ''))
					.join('');
				if (text) parts.push(`## User\n${text}`);
			}
			// Include response text (no diffs)
			const responseText = buildSectionResponseText(responses, mcpServerNames);
			if (responseText) parts.push(responseText);
			// Include diffs
			const diffs = buildSectionDiffsText(responses);
			if (diffs) parts.push(diffs);
			const result = parts.join('\n\n');
			if (result) void copyTextToClipboard(result);
		}, [responses, mcpServerNames, userMessage]);

		const handleCopyResponse = useCallback(() => {
			const text = buildSectionResponseText(responses, mcpServerNames);
			if (text) void copyTextToClipboard(text);
		}, [responses, mcpServerNames]);

		const handleCopyDiffs = useCallback(() => {
			const text = buildSectionDiffsText(responses);
			if (text) void copyTextToClipboard(text);
		}, [responses]);

		const items = useMemo<CopyMenuItem[]>(
			() => [
				{ label: 'Copy Full Turn', action: handleCopyTurn },
				{ label: 'Copy Response Only', action: handleCopyResponse },
				{ label: 'Copy All Diffs', action: handleCopyDiffs },
			],
			[handleCopyTurn, handleCopyResponse, handleCopyDiffs],
		);

		return (
			<div className="relative inline-flex">
				{showDropdown && <CopyDropdown items={items} onClose={() => setShowDropdown(false)} />}
				<button
					type="button"
					onClick={e => {
						e.stopPropagation();
						setShowDropdown(prev => !prev);
					}}
					title="Copy section"
					className="flex items-center justify-center w-5 h-5 rounded-sm text-vscode-descriptionForeground opacity-50 transition-opacity duration-100 hover:opacity-100 cursor-pointer bg-transparent border-none p-0"
				>
					<CopyIcon size={11} />
				</button>
			</div>
		);
	},
);
SectionCopyButton.displayName = 'SectionCopyButton';
