/**
 * @file ConfirmDialog - centered confirmation dialog component
 * @description Global confirmation dialog that appears centered in viewport with proper
 *              padding, centered text, and standard font sizes (text-base 13px).
 *              Used for destructive actions like restore, delete, etc.
 *              Controlled via uiStore for global access from any component.
 *              Features scale-in animation and consistent design system tokens.
 */

import type React from 'react';
import { useCallback, useEffect } from 'react';
import { cn } from '../../lib/cn';
import { useUIActions, useUIStore } from '../../store/uiStore';
import { Button } from './Button';

export const ConfirmDialog: React.FC = () => {
	const confirmDialog = useUIStore(state => state.confirmDialog);
	const { hideConfirmDialog } = useUIActions();

	const handleConfirm = useCallback(() => {
		confirmDialog?.onConfirm();
		hideConfirmDialog();
	}, [confirmDialog, hideConfirmDialog]);

	const handleCancel = useCallback(() => {
		confirmDialog?.onCancel?.();
		hideConfirmDialog();
	}, [confirmDialog, hideConfirmDialog]);

	// Handle Escape key
	useEffect(() => {
		if (!confirmDialog) {
			return undefined;
		}

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleCancel();
			} else if (e.key === 'Enter') {
				handleConfirm();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [confirmDialog, handleCancel, handleConfirm]);

	if (!confirmDialog) {
		return null;
	}

	return (
		<div
			className="fixed inset-0 z-1000 flex items-center justify-center bg-black/50"
			onClick={handleCancel}
			onKeyDown={e => e.key === 'Escape' && handleCancel()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
		>
			<div
				className={cn(
					'flex flex-col gap-(--gap-4) p-(--gap-5)',
					'bg-(--surface-overlay) border border-(--border-default) rounded-lg',
					'shadow-[0_4px_16px_rgba(0,0,0,0.4)]',
					'min-w-70 max-w-90',
					'animate-scale-in',
				)}
				onClick={e => e.stopPropagation()}
				onKeyDown={e => e.stopPropagation()}
			>
				<h2
					id="confirm-dialog-title"
					className="text-base font-semibold text-vscode-foreground m-0 text-center"
				>
					{confirmDialog.title}
				</h2>

				<p className="text-base text-vscode-descriptionForeground m-0 leading-relaxed text-center">
					{confirmDialog.message}
				</p>

				<div className="flex gap-(--gap-4) justify-center pt-(--gap-2)">
					<Button variant="primary" size="md" onClick={handleConfirm} autoFocus>
						{confirmDialog.confirmLabel || 'Confirm'}
					</Button>
					<Button variant="ghost" size="md" onClick={handleCancel}>
						{confirmDialog.cancelLabel || 'Cancel'}
					</Button>
				</div>
			</div>
		</div>
	);
};

ConfirmDialog.displayName = 'ConfirmDialog';
