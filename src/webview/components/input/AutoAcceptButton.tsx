/**
 * @file AutoAcceptButton — Tri-state auto-accept permissions control
 * @description Cycles auto-accept mode for the current session between on,
 *              default UI setting, and off.
 */

import React, { useCallback } from 'react';
import { cn } from '../../lib/cn';
import { useChatStore } from '../../store/chatStore';
import { useVSCode } from '../../utils/vscode';
import { ShieldIcon } from '../icons';
import { Button } from '../ui';

export const AutoAcceptButton: React.FC = React.memo(() => {
	const activeSessionId = useChatStore(s => s.activeSessionId);
	const mode = useChatStore(
		s =>
			(s.activeSessionId
				? s.sessionsById[s.activeSessionId]?.permissionAutoAcceptMode
				: undefined) ?? 'default',
	);
	const autoAccept = useChatStore(
		s => (s.activeSessionId ? s.sessionsById[s.activeSessionId]?.autoAccept : undefined) ?? false,
	);
	const { postMessage } = useVSCode();

	const handleCycle = useCallback(() => {
		const nextMode = mode === 'default' ? 'on' : mode === 'on' ? 'off' : 'default';
		postMessage({ type: 'setAutoAccept', mode: nextMode, sessionId: activeSessionId });
	}, [activeSessionId, mode, postMessage]);

	const title =
		mode === 'on'
			? 'Auto-accept permissions (on)'
			: mode === 'default'
				? `Auto-accept permissions (default UI setting${autoAccept ? ', currently active' : ''})`
				: mode === 'off'
					? 'Auto-accept permissions (off for this session)'
					: 'Auto-accept permissions';

	const toneClass =
		mode === 'default'
			? 'text-vscode-descriptionForeground opacity-70 hover:opacity-100'
			: mode === 'on'
				? 'text-green-400'
				: 'text-yellow-400';

	return (
		<Button
			variant="ghost"
			size="xs"
			onClick={handleCycle}
			title={title}
			aria-pressed={mode === 'on'}
			className={cn(
				'h-(--input-toolbar-height) rounded-md shrink-0 flex items-center px-(--gap-1) transition-colors duration-200 border border-transparent bg-transparent hover:bg-(--alpha-5)',
				toneClass,
			)}
		>
			<ShieldIcon size={13} />
		</Button>
	);
});
AutoAcceptButton.displayName = 'AutoAcceptButton';
