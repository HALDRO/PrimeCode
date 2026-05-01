/**
 * @file Access request message component
 * @description Displays access requests from CLI providers with
 * unified action buttons. Supports provider-specific formats and
 * OpenCode format (once/always/reject). Automatically adapts button behavior based
 * on the active CLI provider from settings store.
 */

import type React from 'react';
import { isToolMatch } from '../../constants';
import { useAccessRequestByToolUseId } from '../../store';
import { Button, GlowDot } from '../ui';
import { useAccessResponse } from './AccessGate';

interface AccessRequestMessageProps {
	toolUseId: string;
}

export const AccessRequestMessage: React.FC<AccessRequestMessageProps> = ({ toolUseId }) => {
	const message = useAccessRequestByToolUseId(toolUseId);
	const requestId = message?.requestId ?? '';
	const sessionId = message?.sessionId;
	const tool = message?.tool ?? '';
	const id = message?.id;
	const handleResponse = useAccessResponse({ requestId, tool, messageId: id, sessionId });
	if (!message) return null;
	const { pattern, input } = message;

	return (
		<div className="mb-(--tool-block-margin)">
			<div className="flex items-center gap-1.5 mb-1 py-px ml-0.5">
				<GlowDot color="var(--vscode-editorWarning-foreground)" glow="var(--glow-warning)" />
				<span className="text-sm leading-none text-warning">Access</span>
				<span className="text-sm leading-none text-vscode-foreground opacity-70 truncate">
					{tool}
				</span>
			</div>

			<div className="ml-0.5">
				<div className="text-sm text-vscode-foreground p-[calc(var(--spacing-0-5))_calc(var(--spacing-1))] mb-1 bg-black/25 rounded-md whitespace-pre-wrap break-all">
					{isToolMatch(tool, 'Bash') && input && typeof input === 'object' && 'command' in input
						? String((input as Record<string, unknown>).command)
						: JSON.stringify(input, null, 2)}
				</div>

				{pattern && (
					<div className="text-sm text-vscode-foreground opacity-60 mb-1">Pattern: {pattern}</div>
				)}

				<div className="flex gap-0-5">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => handleResponse(true)}
						className="p-[calc(var(--spacing-px))_calc(var(--spacing-1))] text-sm text-success hover:bg-success/10"
					>
						Allow
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => handleResponse(true, true)}
						className="p-[calc(var(--spacing-px))_calc(var(--spacing-1))] text-sm text-info hover:bg-info/10"
					>
						Always
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => handleResponse(false)}
						className="p-[calc(var(--spacing-px))_calc(var(--spacing-1))] text-sm text-error hover:bg-error/10"
					>
						Deny
					</Button>
				</div>
			</div>
		</div>
	);
};
