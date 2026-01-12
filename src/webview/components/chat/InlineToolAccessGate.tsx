/**
 * @file Inline tool access gate
 * @description Renders a compact, stylish access request banner embedded inside tool cards.
 *              Uses VS Code-native styling with subtle warning accent. For file operations,
 *              only shows minimal info since content is visible in diff viewer below.
 */

import type React from 'react';
import { isToolInList } from '../../constants';
import { cn } from '../../lib/cn';
import { useVSCode } from '../../utils/vscode';
import { CheckIcon, CloseIcon, ShieldIcon } from '../icons';
import { Tooltip } from '../ui';

export interface InlineToolAccessGateProps {
	requestId: string;
	tool: string;
	input: Record<string, unknown> | unknown;
	pattern?: string;
	className?: string;
}

/** Tools that write/edit files - content shown in diff viewer */
const FILE_EDIT_TOOLS = ['Write', 'Edit', 'write', 'edit', 'patch', 'multiedit'] as const;

/** Tools where command/details are shown in the parent container header */
const HEADER_DISPLAY_TOOLS = ['Bash', 'bash'] as const;

/**
 * Extract display-friendly details from tool input.
 * For file operations, returns null (content is in diff viewer).
 * For bash, returns null (command is shown in parent header).
 * For others, show minimal info.
 */
function getDisplayDetails(tool: string, input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}

	const inputObj = input as Record<string, unknown>;

	// Bash tool - command is already shown in parent container header
	if (isToolInList(tool, HEADER_DISPLAY_TOOLS)) {
		return null;
	}

	// File write/edit tools - content is already shown in diff viewer
	if (isToolInList(tool, FILE_EDIT_TOOLS)) {
		return null;
	}

	// For other tools, show compact JSON without large content fields
	const filtered = Object.fromEntries(
		Object.entries(inputObj).filter(
			([key]) => !['content', 'new_content', 'old_content', 'file_content'].includes(key),
		),
	);

	if (Object.keys(filtered).length === 0) {
		return null;
	}
	return JSON.stringify(filtered, null, 2);
}

export const InlineToolAccessGate: React.FC<InlineToolAccessGateProps> = ({
	requestId,
	tool,
	input,
	className,
}) => {
	const { postMessage } = useVSCode();

	const handleResponse = (isApproved: boolean, alwaysAllow = false) => {
		postMessage('accessResponse', {
			id: requestId,
			approved: isApproved,
			alwaysAllow,
			response: isApproved ? (alwaysAllow ? 'always' : 'once') : 'reject',
		});
	};

	const details = getDisplayDetails(tool, input);

	return (
		<div className={cn('py-1', className)}>
			{/* Single row: label left, buttons centered */}
			<div className="flex items-center gap-2">
				{/* Left: icon + label */}
				<div className="flex items-center gap-1.5 shrink-0">
					<div className="flex items-center justify-center w-5 h-5 rounded bg-warning/15">
						<ShieldIcon size={12} className="text-warning" />
					</div>
					<span className="text-sm text-warning font-medium font-(family-name:--vscode-font-family)">
						Permission
					</span>
				</div>

				{/* Center: action buttons */}
				<div className="flex-1 flex items-center justify-center gap-2">
					<Tooltip content="Allow once" position="top" delay={150}>
						<button
							type="button"
							onClick={() => handleResponse(true)}
							className="flex items-center gap-1 h-(--btn-height-sm) px-2.5 rounded text-sm font-medium bg-success/15 text-success hover:bg-success/25 transition-colors cursor-pointer border-none"
						>
							<CheckIcon size={12} />
							<span>Allow</span>
						</button>
					</Tooltip>

					<Tooltip content="Always allow this pattern" position="top" delay={150}>
						<button
							type="button"
							onClick={() => handleResponse(true, true)}
							className="flex items-center gap-1 h-(--btn-height-sm) px-2.5 rounded text-sm font-medium bg-info/15 text-info hover:bg-info/25 transition-colors cursor-pointer border-none"
						>
							<CheckIcon size={12} />
							<span>Always</span>
						</button>
					</Tooltip>

					<Tooltip content="Deny this action" position="top" delay={150}>
						<button
							type="button"
							onClick={() => handleResponse(false)}
							className="flex items-center gap-1 h-(--btn-height-sm) px-2.5 rounded text-sm font-medium bg-error/15 text-error hover:bg-error/25 transition-colors cursor-pointer border-none"
						>
							<CloseIcon size={12} />
							<span>Deny</span>
						</button>
					</Tooltip>
				</div>
			</div>

			{/* Details (only for bash commands, etc.) */}
			{details && (
				<div className="mt-1.5 p-1.5 rounded bg-black/20 text-xs font-mono text-vscode-foreground/70 whitespace-pre-wrap break-all max-h-(--content-max-height-sm) overflow-auto">
					{details}
				</div>
			)}
		</div>
	);
};
