/**
 * @file ImagePreviewModal — Fullscreen image preview with click-outside support
 * @description Extracted from ChatInput. Opens on image click, closes on backdrop/Escape.
 */

import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

interface ImagePreviewModalProps {
	dataUrl: string;
	name: string;
	onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ dataUrl, name, onClose }) => {
	const contentRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	const handleBackdropClick = useCallback(
		(e: React.MouseEvent) => {
			if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
				onClose();
			}
		},
		[onClose],
	);

	return (
		<div
			className="fixed inset-0 z-9999 flex items-center justify-center bg-black/(--image-preview-backdrop) animate-fade-in cursor-pointer"
			onClick={handleBackdropClick}
		>
			<div
				ref={contentRef}
				className="relative max-w-(--image-preview-max-vw) max-h-(--image-preview-max-vh) cursor-default animate-preview-in-modal"
			>
				<button
					type="button"
					aria-label="Close preview"
					onClick={onClose}
					className="absolute -top-(--image-preview-close-offset) -right-(--image-preview-close-offset) z-10 w-(--image-preview-close-size) h-(--image-preview-close-size) flex items-center justify-center rounded-full bg-(--alpha-10) text-vscode-foreground hover:bg-(--alpha-20) hover:text-vscode-foreground transition-colors duration-150 cursor-pointer"
					title="Close"
				>
					<span className="text-sm leading-none">&times;</span>
				</button>
				<img
					src={dataUrl}
					alt={name}
					className="max-w-(--image-preview-max-vw) max-h-(--image-preview-max-vh) object-contain"
				/>
			</div>
		</div>
	);
};
ImagePreviewModal.displayName = 'ImagePreviewModal';
