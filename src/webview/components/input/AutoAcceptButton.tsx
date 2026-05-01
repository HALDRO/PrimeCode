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
import { GlowDot } from '../ui/GlowDot';

const MODE_DOT_COLORS = {
	on: { color: 'var(--color-success)', glow: 'var(--glow-success)' },
	off: { color: 'var(--color-warning)', glow: 'var(--glow-warning)' },
} as const;

type AutoAcceptMode = 'default' | 'on' | 'off';

export const AutoAcceptButton: React.FC = React.memo(() => {
	const activeSessionId = useChatStore(s => s.activeSessionId);
	const mode = useChatStore(
		s =>
			(s.activeSessionId
				? s.sessionAutoAccept[s.activeSessionId]
					? 'on'
					: 'default'
				: undefined) ?? 'default',
	) as AutoAcceptMode;
	const autoAccept = useChatStore(
		s => (s.activeSessionId ? s.sessionAutoAccept[s.activeSessionId] : undefined) ?? false,
	);
	const { postMessage } = useVSCode();

	const handleCycle = useCallback(() => {
		if (!activeSessionId) return;
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

	const dotColors = mode === 'on' || mode === 'off' ? MODE_DOT_COLORS[mode] : undefined;

	return (
		<button
			type="button"
			onClick={handleCycle}
			title={title}
			aria-pressed={mode === 'on'}
			className={cn(
				'group/permissions relative h-(--input-toolbar-height) w-(--input-toolbar-height) rounded shrink-0 inline-flex items-center justify-center cursor-pointer p-0 border-none bg-(--surface-raised) text-vscode-foreground opacity-70 transition-all duration-200 hover:opacity-100 hover:bg-white/10 focus:outline-none',
			)}
		>
			<ShieldIcon
				size={13}
				className="transition-transform duration-200 group-hover/permissions:scale-110"
			/>
			{dotColors && (
				<span className="absolute bottom-[3px] right-[5px] pointer-events-none">
					<GlowDot color={dotColors.color} glow={dotColors.glow} size={4} />
				</span>
			)}
		</button>
	);
});
AutoAcceptButton.displayName = 'AutoAcceptButton';
