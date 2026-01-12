/**
 * @file ConfirmDialog - centered confirmation dialog component
 * @description Global confirmation dialog that appears centered in viewport.
 *              Used for destructive actions like restore, delete, etc.
 *              Controlled via uiStore for global access from any component.
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
			className="fixed inset-0 z-1000 flex items-center justify-center bg-black/40"
			onClick={handleCancel}
			onKeyDown={e => e.key === 'Escape' && handleCancel()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
		>
			<div
				className={cn(
					'flex flex-col gap-(--space-6) p-(--space-8)',
					'bg-(--input-bg) border border-(--input-border) rounded-(--input-radius)',
					'shadow-[0_2px_8px_rgba(0,0,0,0.3)]',
				)}
				onClick={e => e.stopPropagation()}
				onKeyDown={e => e.stopPropagation()}
			>
				<h2 id="confirm-dialog-title" className="text-xs font-medium text-vscode-foreground m-0">
					{confirmDialog.title}
				</h2>

				<p className="text-sm text-vscode-descriptionForeground m-0 leading-normal max-w-(--input-width-lg)">
					{confirmDialog.message}
				</p>

				<div className="flex gap-(--space-4) justify-center">
					<Button variant="primary" size="sm" onClick={handleConfirm} autoFocus>
						{confirmDialog.confirmLabel || 'Confirm'}
					</Button>
					<Button variant="ghost" size="sm" onClick={handleCancel}>
						{confirmDialog.cancelLabel || 'Cancel'}
					</Button>
				</div>
			</div>
		</div>
	);
};

ConfirmDialog.displayName = 'ConfirmDialog';
