/**
 * @file Access request message component
 * @description Displays access requests from CLI providers (Claude/OpenCode) with
 * unified action buttons. Supports both Claude format (approved/alwaysAllow) and
 * OpenCode format (once/always/reject). Automatically adapts button behavior based
 * on the active CLI provider from settings store.
 */

import type React from 'react';
import { isToolMatch } from '../../constants';
import { type Message, useChatActions } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { Button, GlowDot } from '../ui';

interface AccessRequestMessageProps {
	message: Extract<Message, { type: 'access_request' }>;
}

export const AccessRequestMessage: React.FC<AccessRequestMessageProps> = ({ message }) => {
	const { postMessage } = useVSCode();
	const { updateMessage } = useChatActions();
	const { requestId, tool, pattern, input, resolved, approved, id } = message;

	const handleResponse = (isApproved: boolean, alwaysAllow = false) => {
		// Send unified response format that works for both providers
		// The extension backend will convert to the appropriate format
		postMessage('accessResponse', {
			id: requestId,
			approved: isApproved,
			alwaysAllow,
			// Include OpenCode-compatible response for direct handling
			response: isApproved ? (alwaysAllow ? 'always' : 'once') : 'reject',
		});

		if (id) {
			updateMessage(id, {
				resolved: true,
				approved: isApproved,
			});
		}
	};

	if (resolved) {
		const dotColor = approved ? 'var(--color-success)' : 'var(--color-error)';
		const dotGlow = approved ? 'var(--glow-success)' : 'var(--glow-error)';

		return (
			<div className="flex items-center gap-1.5 mb-0-5 py-px ml-0.5">
				<GlowDot color={dotColor} glow={dotGlow} />
				<span className="text-sm leading-none" style={{ color: dotColor }}>
					{approved ? 'Approved' : 'Denied'}
				</span>
				<span className="text-sm leading-none text-vscode-foreground opacity-70">{tool}</span>
			</div>
		);
	}

	return (
		<div className="flex gap-1.5 items-start mb-0-5 ml-0.5">
			<span className="flex items-center h-(--h-xs)">
				<GlowDot color="var(--vscode-editorWarning-foreground)" glow="var(--glow-warning)" />
			</span>

			<div className="flex-1">
				<div className="text-sm text-warning mb-0-5">Access: {tool}</div>

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
