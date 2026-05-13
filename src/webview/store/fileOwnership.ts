/**
 * @file Session file ownership extraction
 * @description Extracts explicit file ownership signals from mutating tool parts.
 * Uses canonical tool normalization plus structured action parsing so the webview
 * can distinguish files clearly touched by a given session from unrelated worktree
 * diff noise returned by upstream session.diff snapshots.
 */

import type { Message, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import { buildToolActionType } from '../../common/normalizedTypes';
import { extractPatchFilePaths, FILE_EDIT_TOOLS, resolveToolName } from '../../common/toolRegistry';
import { normalizeComparablePath } from '../../utils/path';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getPath(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0
		? normalizeComparablePath(value.trim()).replace(/^\.\//, '')
		: undefined;
}

function collectMetadataPaths(metadata: Record<string, unknown> | undefined): string[] {
	if (!metadata) return [];
	const result = new Set<string>();
	const direct = [metadata.path, metadata.filePath, metadata.file_path, metadata.relativePath];
	for (const value of direct) {
		const path = getPath(value);
		if (path) result.add(path);
	}
	const files = metadata.files;
	if (Array.isArray(files)) {
		for (const item of files) {
			if (!isRecord(item)) continue;
			const candidates = [item.path, item.filePath, item.file_path, item.relativePath];
			for (const candidate of candidates) {
				const path = getPath(candidate);
				if (path) result.add(path);
			}
		}
	}
	return [...result];
}

export function extractOwnedFilePaths(toolPart: ToolPart): string[] {
	const canonical = resolveToolName(toolPart.tool);
	if (!canonical || !FILE_EDIT_TOOLS.has(canonical)) return [];
	const input = isRecord(toolPart.state.input) ? toolPart.state.input : {};
	const metadata = isRecord(toolPart.metadata)
		? toolPart.metadata
		: 'metadata' in toolPart.state && isRecord(toolPart.state.metadata)
			? toolPart.state.metadata
			: undefined;
	return extractOwnedFilePathsFromToolState(toolPart.tool, input, metadata);
}

export function extractOwnedFilePathsFromToolState(
	toolName: string,
	input: Record<string, unknown>,
	metadata?: Record<string, unknown>,
): string[] {
	const canonical = resolveToolName(toolName);
	if (!canonical || !FILE_EDIT_TOOLS.has(canonical)) return [];
	const action = buildToolActionType(canonical, input);
	const owned = new Set<string>();

	if (action.type === 'FileEdit') {
		const path = getPath(action.path);
		if (path) owned.add(path);
	}

	if (action.type === 'ApplyPatch') {
		for (const file of action.files) {
			const path = getPath(file.path);
			if (path) owned.add(path);
			const newPath = getPath(file.newPath);
			if (newPath) owned.add(newPath);
		}
	}

	for (const path of extractPatchFilePaths(input)) {
		const normalized = getPath(path);
		if (normalized) owned.add(normalized);
	}

	for (const path of collectMetadataPaths(metadata)) {
		owned.add(path);
	}

	return [...owned];
}

export function rebuildSessionOwnedFiles(
	sessionMessages: Message[],
	partsByMessageId: Record<string, Part[]>,
	sessionId: string,
): string[] {
	const owned = new Set<string>();
	for (const message of sessionMessages) {
		const parts = partsByMessageId[message.id] ?? [];
		for (const part of parts) {
			if (part.sessionID !== sessionId || part.type !== 'tool') continue;
			for (const path of extractOwnedFilePaths(part as ToolPart)) {
				owned.add(path);
			}
		}
	}
	return [...owned];
}
