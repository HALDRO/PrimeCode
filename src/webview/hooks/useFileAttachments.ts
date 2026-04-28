/**
 * @file useFileAttachments
 * @description Webview hook that manages message attachments: file references, images, and code snippets.
 *              Intercepts paste/drag-drop events and exposes stable handlers/state for the chat input.
 *
 * Design principles:
 * - Paste: only intercept when clipboard contains images. Text paste is never blocked.
 * - Drag-and-drop: support both workspace and external files/directories.
 *   Files from dataTransfer.files (external drops) are handled alongside text/URI paths.
 * - No heuristic "looks like code" detection — this caused false positives and errors.
 */

import { useCallback, useEffect, useState } from 'react';
import { decodeFilePath } from '../../utils/path';
import { useVSCode } from '../utils/vscode';

interface AttachedImage {
	id: string;
	name: string;
	dataUrl: string;
	file?: File;
	path?: string;
}

interface UseFileAttachmentsOptions {
	initialImages?: Array<{
		id: string;
		name: string;
		dataUrl: string;
		path?: string;
	}>;
	onAttachPath?: (path: string) => void;
}

/** Image extensions for path-based detection */
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;

function isSameAttachedImage(
	left: Pick<AttachedImage, 'dataUrl' | 'path' | 'name'>,
	right: Pick<AttachedImage, 'dataUrl' | 'path' | 'name'>,
): boolean {
	if (left.dataUrl && right.dataUrl && left.dataUrl === right.dataUrl) {
		return true;
	}

	if (left.path && right.path && left.path === right.path) {
		return true;
	}

	return left.name === right.name && left.dataUrl === right.dataUrl;
}

function dedupeAttachedImages(images: AttachedImage[]): AttachedImage[] {
	return images.reduce<AttachedImage[]>((deduped, image) => {
		if (deduped.some(existing => isSameAttachedImage(existing, image))) return deduped;
		deduped.push(image);
		return deduped;
	}, []);
}

export function useFileAttachments(options: UseFileAttachmentsOptions = {}) {
	const { initialImages = [], onAttachPath } = options;
	const { postMessage } = useVSCode();
	const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() =>
		dedupeAttachedImages(initialImages.map(img => ({ ...img, file: undefined }))),
	);
	const [isDragOver, setIsDragOver] = useState(false);

	// Handlers for managing attachments
	const addFile = useCallback(
		(filePath: string) => {
			const normalized = filePath.trim();
			if (!normalized) return;
			if (onAttachPath) {
				onAttachPath(normalized);
				return;
			}
		},
		[onAttachPath],
	);

	const removeImage = useCallback((id: string) => {
		setAttachedImages(prev => prev.filter(img => img.id !== id));
	}, []);

	const addAttachedImage = useCallback(
		(image: { id: string; name: string; dataUrl: string; file?: File; path?: string }) => {
			setAttachedImages(prev => {
				if (prev.some(existing => isSameAttachedImage(existing, image))) {
					return prev;
				}
				return [...prev, image];
			});
		},
		[],
	);

	const clearAll = useCallback(() => {
		setAttachedImages([]);
	}, []);

	// ── Drag & Drop ──────────────────────────────────────────────────────

	const handleDragOver = useCallback((e: React.DragEvent) => {
		// preventDefault + stopPropagation prevents VS Code from intercepting the drop.
		// In webview (Electron), this works without Shift — unlike the text editor API.
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
		e.dataTransfer.dropEffect = 'copy';
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only reset isDragOver when the cursor actually leaves the container,
		// not when it moves over a child element (classic dragleave bubbling bug).
		const container = e.currentTarget as HTMLElement;
		if (!container.contains(e.relatedTarget as Node)) {
			setIsDragOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);

			let handledFiles = false;

			// 1. Handle files from dataTransfer.files (external drops from OS file manager)
			const files = e.dataTransfer.files;
			if (files && files.length > 0) {
				handledFiles = true;
				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					if (file.type.startsWith('image/')) {
						// Image file — read as data URL
						const reader = new FileReader();
						reader.onload = ev => {
							const dataUrl = ev.target?.result as string;
							if (dataUrl) {
								const id = `img-${crypto.randomUUID()}`;
								addAttachedImage({ id, name: file.name, dataUrl, file });
							}
						};
						reader.readAsDataURL(file);
					} else {
						// Non-image file — try to get its path.
						// In webview, File objects from external drops may have a `path` property
						// (Electron/VS Code webview exposes this). Use it if available.
						const filePath = (file as File & { path?: string }).path;
						if (filePath) {
							addFile(filePath);
						}
					}
				}
			}

			// 2. Handle text/URI paths (from VS Code file tree, or other sources)
			const textPlain = e.dataTransfer.getData('text');
			const textUriList = e.dataTransfer.getData('application/vnd.code.uri-list');
			const text = textPlain || textUriList;

			if (text) {
				const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
				for (const line of lines) {
					const processedPath = decodeFilePath(line);
					if (!processedPath) continue;

					// Check for images passed as paths
					if (IMAGE_EXT_RE.test(processedPath)) {
						const name = processedPath.split(/[/\\]/).pop() || 'image';
						const id = `img-${crypto.randomUUID()}`;
						postMessage({ type: 'getImageData', path: processedPath, id, name });
						continue;
					}

					// Regular file/directory path
					addFile(processedPath);
				}
			} else if (!handledFiles) {
				// No text data and no files — nothing to do
			}
		},
		[addAttachedImage, addFile, postMessage],
	);

	// ── Paste ────────────────────────────────────────────────────────────
	// Only intercept when clipboard contains images. Text paste is never blocked.

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const clipboardData = e.clipboardData;
			if (!clipboardData) return;

			// 1. Images — intercept and handle (browser can't insert images into textarea)
			const items = clipboardData.items;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.type.startsWith('image/')) {
					e.preventDefault();
					const file = item.getAsFile();
					if (file) {
						const reader = new FileReader();
						reader.onload = ev => {
							const dataUrl = ev.target?.result as string;
							if (dataUrl) {
								const id = `img-${crypto.randomUUID()}`;
								addAttachedImage({ id, name: file.name, dataUrl, file });
							}
						};
						reader.readAsDataURL(file);
					}
					return;
				}
			}

			// 2. Text — let the browser handle the paste normally (no preventDefault!).
			//    Text is simply inserted into the input by the browser/CM6.
		},
		[addAttachedImage],
	);

	// ── Extension message listener ───────────────────────────────────────

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;

			if (message?.type === 'imageData' && message.dataUrl) {
				const id = message.id || `img-${crypto.randomUUID()}`;
				const name = message.name || 'image.png';
				addAttachedImage({ id, name, dataUrl: message.dataUrl, path: message.path });
			}

			if (message?.type === 'browsedFiles' && Array.isArray(message.paths)) {
				for (const filePath of message.paths as string[]) {
					const trimmed = filePath.trim();
					if (trimmed) addFile(trimmed);
				}
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, [addAttachedImage, addFile]);

	return {
		attachedImages,
		isDragOver,
		addFile,
		addImage: addAttachedImage,
		removeImage,
		clearAll,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
	};
}
