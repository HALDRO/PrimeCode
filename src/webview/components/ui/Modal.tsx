/**
 * @file Modal - dialog overlay component
 * @description Accessible modal dialog with backdrop, keyboard handling (Escape to close),
 *              and click-outside-to-close behavior. Uses ScrollContainer for content overflow.
 *              Follows WAI-ARIA dialog pattern with proper focus management.
 */

import type React from 'react';
import { useEffect } from 'react';
import { CloseIcon } from '../icons';
import { IconButton } from './Button';
import { ScrollContainer } from './ScrollContainer';

interface ModalProps {
	/** Modal title displayed in header */
	title: string;
	/** Controls modal visibility */
	isOpen: boolean;
	/** Callback when modal should close */
	onClose: () => void;
	/** Modal content */
	children: React.ReactNode;
	/** Modal width (default: 700px) */
	width?: string;
}

export const Modal: React.FC<ModalProps> = ({
	title,
	isOpen,
	onClose,
	children,
	width = 'var(--modal-width-lg)',
}) => {
	useEffect(() => {
		const handleEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		if (isOpen) {
			window.addEventListener('keydown', handleEsc);
		}
		return () => window.removeEventListener('keydown', handleEsc);
	}, [isOpen, onClose]);

	if (!isOpen) {
		return null;
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="modal-title"
			className="fixed inset-0 z-1000 flex items-center justify-center bg-black/50"
			onClick={e => {
				if (e.target === e.currentTarget) {
					onClose();
				}
			}}
			onKeyDown={e => {
				if (e.key === 'Escape') {
					onClose();
				}
			}}
		>
			<div
				className="flex flex-col bg-vscode-sideBar-background border border-vscode-panel-border rounded-lg shadow-2xl overflow-hidden"
				style={{
					width,
					maxWidth: '90vw',
					maxHeight: '80vh',
				}}
			>
				<div className="flex items-center justify-between shrink-0 p-[var(--modal-header-padding-y)_var(--modal-header-padding-x)] border-b border-vscode-panel-border">
					<span id="modal-title" className="font-semibold text-base text-vscode-foreground">
						{title}
					</span>
					<IconButton icon={<CloseIcon size={14} />} onClick={onClose} title="Close" size="md" />
				</div>

				<ScrollContainer className="flex-1 p-(--modal-padding)">{children}</ScrollContainer>
			</div>
		</div>
	);
};
