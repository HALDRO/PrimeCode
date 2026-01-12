/**
 * @file Context usage progress bar component for chat input
 * @description Displays a responsive SVG progress bar showing token context usage.
 *              On hover, shows a detailed stats popup using SessionStatsDisplay.
 */

import {
	autoUpdate,
	flip,
	offset,
	shift,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useRole,
	useTransitionStyles,
} from '@floating-ui/react';
import type React from 'react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useModelContextWindow, useTotalStats } from '../../store';
import { SessionStatsDisplay } from '../ui';

const VIEW_BOX_WIDTH = 100;
const VIEW_BOX_HEIGHT = 4;
const TAPER_WIDTH = 2;

const TRACK_PATH = `
	M 0 0
	L ${VIEW_BOX_WIDTH} 0
	L ${VIEW_BOX_WIDTH} ${VIEW_BOX_HEIGHT - TAPER_WIDTH}
	Q ${VIEW_BOX_WIDTH} ${VIEW_BOX_HEIGHT} ${VIEW_BOX_WIDTH - TAPER_WIDTH} ${VIEW_BOX_HEIGHT}
	L ${TAPER_WIDTH} ${VIEW_BOX_HEIGHT}
	Q 0 ${VIEW_BOX_HEIGHT} 0 ${VIEW_BOX_HEIGHT - TAPER_WIDTH}
	Z
`;

const MIDDLEWARE = [offset(6), flip({ padding: 8 }), shift({ padding: 8 })];

export const ContextBar: React.FC = () => {
	const [isOpen, setIsOpen] = useState(false);

	const totalStats = useTotalStats();
	const contextLimit = useModelContextWindow();

	const totalTokens = totalStats.totalTokensInput + totalStats.totalTokensOutput;
	const percentage = Math.min((totalTokens / contextLimit) * 100, 100);

	const { refs, floatingStyles, context } = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'top',
		whileElementsMounted: (reference, floating, update) =>
			autoUpdate(reference, floating, update, {
				animationFrame: false,
				elementResize: false,
				layoutShift: false,
			}),
		middleware: MIDDLEWARE,
	});

	const hover = useHover(context, { move: false });
	const focus = useFocus(context);
	const dismiss = useDismiss(context);
	const role = useRole(context, { role: 'tooltip' });

	const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

	const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
		duration: 100,
		initial: { opacity: 0 },
	});

	return (
		<div className="w-full flex justify-center px-2 box-border">
			<div
				ref={refs.setReference}
				style={{ height: `${VIEW_BOX_HEIGHT}px` }}
				className="w-full max-w-(--input-width-md) cursor-help"
				{...getReferenceProps()}
			>
				<svg
					width="100%"
					height={VIEW_BOX_HEIGHT}
					className="block"
					viewBox={`0 0 ${VIEW_BOX_WIDTH} ${VIEW_BOX_HEIGHT}`}
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					<defs>
						<clipPath id="barClip">
							<path d={TRACK_PATH} />
						</clipPath>
					</defs>

					<path d={TRACK_PATH} fill="var(--context-bar-track)" />

					<rect
						x="0"
						y="0"
						width={`${percentage}%`}
						height={VIEW_BOX_HEIGHT}
						fill="var(--context-bar-fill)"
						clipPath="url(#barClip)"
						className="transition-[width] duration-400 ease-out"
					/>
				</svg>
			</div>

			{isMounted &&
				createPortal(
					<div
						ref={refs.setFloating}
						style={{
							...floatingStyles,
							...transitionStyles,
						}}
						className={cn(
							'h-(--tool-header-height) px-1-5 font-(family-name:--vscode-font-family)',
							'bg-(--panel-header-bg) border border-(--panel-header-border) rounded-md',
							'whitespace-nowrap pointer-events-none z-10000 shadow-[0_2px_8px_rgba(0,0,0,0.3)]',
						)}
						{...getFloatingProps()}
					>
						<SessionStatsDisplay mode="tooltip" />
					</div>,
					document.body,
				)}
		</div>
	);
};
