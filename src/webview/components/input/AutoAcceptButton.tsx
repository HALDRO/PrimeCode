/**
 * @file AutoAcceptButton — Toggle button for auto-accepting permissions
 * @description Toggles auto-accept mode for the current session. When active,
 *              all permission requests are automatically approved.
 *              Only the icon color changes — no background/border changes.
 */

import React, { useCallback } from 'react';
import { cn } from '../../lib/cn';
import { useSessionAutoAccept } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { useVSCode } from '../../utils/vscode';
import { ShieldIcon } from '../icons';
import { Button } from '../ui';

export const AutoAcceptButton: React.FC = React.memo(() => {
	const autoAccept = useSessionAutoAccept();
	const activeSessionId = useChatStore(s => s.activeSessionId);
	const { updateSession } = useChatStore(s => s.actions);
	const { postMessage } = useVSCode();

	const handleToggle = useCallback(() => {
		const newValue = !autoAccept;
		updateSession({ autoAccept: newValue });
		// Notify extension so it can update permission handling
		postMessage({ type: 'setAutoAccept', enabled: newValue, sessionId: activeSessionId });
	}, [activeSessionId, autoAccept, updateSession, postMessage]);

	return (
		<Button
			variant="ghost"
			size="xs"
			onClick={handleToggle}
			title={autoAccept ? 'Auto-accept permissions (on)' : 'Auto-accept permissions (off)'}
			aria-pressed={autoAccept}
			className={cn(
				'h-(--input-toolbar-height) rounded-md shrink-0 flex items-center px-(--gap-1) transition-colors duration-200 border border-transparent bg-transparent hover:bg-(--alpha-5)',
				autoAccept ? 'text-green-400' : 'opacity-70 hover:opacity-100',
			)}
		>
			<ShieldIcon size={13} />
		</Button>
	);
});
AutoAcceptButton.displayName = 'AutoAcceptButton';
