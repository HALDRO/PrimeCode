/**
 * @file Access gate component
 * @description Permission control shown under ToolCards.
 *              Primary action is one-click allow; other actions are in a dropdown.
 */

import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useAccessResponse } from '../../hooks/useAccessResponse';
import { cn } from '../../lib/cn';
import { CheckIcon, ChevronDownIcon, CloseIcon, ShieldIcon } from '../icons';
import { DropdownMenu } from '../ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccessGateProps {
	/** Permission request id */
	requestId: string;
	/** Store message id (for optimistic update) */
	messageId?: string;
	/** Tool name */
	tool: string;
	/** Tool input payload */
	input: Record<string, unknown> | unknown;
	/** Optional glob pattern */
	pattern?: string;
	className?: string;
	/** Hide input details (e.g. when diff or command is already visible) */
	hideDetails?: boolean;
}

type GateAction = 'allow-once' | 'always-allow' | 'deny';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDisplayDetails(input: unknown, hideDetails?: boolean): string | null {
	if (hideDetails) {
		return null;
	}
	if (!input || typeof input !== 'object') {
		return null;
	}

	const inputObj = input as Record<string, unknown>;

	// Avoid huge content payloads; ToolCard already renders diff/command output separately.
	const filtered = Object.fromEntries(
		Object.entries(inputObj).filter(
			([key]) => !['content', 'new_content', 'old_content', 'file_content'].includes(key),
		),
	);

	if (Object.keys(filtered).length === 0) {
		return null;
	}

	try {
		return JSON.stringify(filtered, null, 2);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AccessGate: React.FC<AccessGateProps> = ({
	requestId,
	messageId,
	tool,
	input,
	pattern: _pattern,
	className,
	hideDetails,
}) => {
	const handleResponse = useAccessResponse({ requestId, tool, messageId });
	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement>(null);

	const details = useMemo(() => getDisplayDetails(input, hideDetails), [input, hideDetails]);

	return (
		<div className={cn('px-(--tool-content-padding) pt-0 pb-1', className)}>
			<div
				className={cn(
					'-mt-px flex items-center gap-2',
					'bg-(--tool-bg-header) border border-(--tool-border-color) border-t-0',
					'rounded-b-md rounded-t-none',
					'px-2 py-1',
				)}
			>
				{/* Left: access icon + actions (primary + split dropdown) */}
				<div className="flex items-center gap-2 min-w-0 flex-1">
					<div className="flex items-center justify-center w-5 h-5 shrink-0">
						<ShieldIcon size={14} className="text-warning" />
					</div>

					<div className="flex items-center shrink-0">
						<div
							className={cn(
								'inline-flex items-stretch overflow-hidden rounded-md',
								'border border-(--tool-border-color)',
							)}
						>
							<button
								type="button"
								onClick={() => handleResponse(true)}
								className={cn(
									'inline-flex items-center gap-1.5',
									'h-[20px] px-2',
									'bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground',
									'hover:bg-vscode-button-secondaryHoverBackground',
									'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
								)}
								title="Allow once"
							>
								<CheckIcon size={14} />
								<span className="text-sm font-medium">Allow</span>
							</button>

							<button
								ref={anchorRef}
								type="button"
								onClick={() => setMenuOpen(prev => !prev)}
								className={cn(
									'inline-flex items-center justify-center',
									'h-[20px] w-[20px]',
									'bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground',
									'hover:bg-vscode-button-secondaryHoverBackground',
									'border-l border-(--tool-border-color)',
									'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
								)}
								aria-label="More permission actions"
								title="More actions"
							>
								<ChevronDownIcon
									size={14}
									className={cn('transition-transform', menuOpen && 'rotate-180')}
								/>
							</button>
						</div>

						{menuOpen && (
							<DropdownMenu<GateAction>
								anchorElement={anchorRef.current}
								onClose={() => setMenuOpen(false)}
								position="top"
								minWidth={180}
								maxWidth={260}
								disableKeyboardNav={false}
								keyHints={{ navigate: true, select: true, close: true }}
								items={[
									{
										id: 'allow-once',
										label: 'Allow once',
										data: 'allow-once',
										icon: <CheckIcon size={14} />,
									},
									{
										id: 'always-allow',
										label: 'Always allow',
										data: 'always-allow',
										icon: <ShieldIcon size={14} />,
										description: 'Remember this choice for the current pattern',
									},
									{
										id: 'deny',
										label: 'Deny',
										data: 'deny',
										icon: <CloseIcon size={14} />,
										danger: true,
									},
								]}
								onSelect={action => {
									setMenuOpen(false);
									switch (action) {
										case 'allow-once':
											handleResponse(true);
											break;
										case 'always-allow':
											handleResponse(true, true);
											break;
										case 'deny':
											handleResponse(false);
											break;
									}
								}}
							/>
						)}
					</div>
				</div>
			</div>

			{details && (
				<div className="mt-1.5 p-1.5 rounded border border-(--tool-border-color) bg-(--alpha-5) text-xs font-mono text-(--alpha-70) whitespace-pre-wrap break-all max-h-(--content-max-height-sm) overflow-auto">
					{details}
				</div>
			)}
		</div>
	);
};
