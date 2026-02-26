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
import { useVSCode } from '../utils/vscode';

interface CodeSnippet {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

interface AttachedImage {
	id: string;
	name: string;
	dataUrl: string;
	file?: File;
	path?: string;
}

interface UseFileAttachmentsOptions {
	initialFiles?: string[];
	initialCodeSnippets?: Array<{
		filePath: string;
		startLine: number;
		endLine: number;
		content: string;
	}>;
	initialImages?: Array<{
		id: string;
		name: string;
		dataUrl: string;
		path?: string;
	}>;
}

/** Image extensions for path-based detection */
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;

/**
 * Normalize a dropped/pasted path: strip file:// prefix, decode URI components,
 * and handle Windows drive-letter URIs (e.g. file:///C:/foo).
 */
function normalizePath(raw: string): string {
	let p = raw.trim();
	if (p.startsWith('file:///')) {
		// file:///C:/foo → C:/foo  (Windows)
		// file:///home/user → /home/user (Unix)
		p = p.substring(8); // strip "file:///"
		// On Windows the path starts with drive letter, on Unix we need the leading /
		if (!/^[a-zA-Z]:/.test(p)) {
			p = `/${p}`;
		}
	} else if (p.startsWith('file://')) {
		p = p.substring(7);
	}
	try {
		p = decodeURIComponent(p);
	} catch {
		// already decoded or malformed — use as-is
	}
	return p;
}

export function useFileAttachments(options: UseFileAttachmentsOptions = {}) {
	const { initialFiles = [], initialCodeSnippets = [], initialImages = [] } = options;
	const { postMessage } = useVSCode();
	const [attachedFiles, setAttachedFiles] = useState<string[]>(initialFiles);
	const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(
		initialImages.map(img => ({ ...img, file: undefined })),
	);
	const [codeSnippets, setCodeSnippets] = useState<CodeSnippet[]>(
		initialCodeSnippets.map(s => ({
			...s,
			id: `${s.filePath}:${s.startLine}-${s.endLine}`,
		})),
	);
	const [isDragOver, setIsDragOver] = useState(false);

	// Handlers for managing attachments
	const addFile = useCallback((filePath: string) => {
		const normalized = filePath.trim();
		if (!normalized) return;
		setAttachedFiles(prev => {
			if (prev.includes(normalized)) {
				return prev;
			}
			return [...prev, normalized];
		});
	}, []);

	const removeFile = useCallback((filePath: string) => {
		setAttachedFiles(prev => prev.filter(f => f !== filePath));
	}, []);

	const removeImage = useCallback((id: string) => {
		setAttachedImages(prev => prev.filter(img => img.id !== id));
	}, []);

	const removeCodeSnippet = useCallback((id: string) => {
		setCodeSnippets(prev => prev.filter(s => s.id !== id));
	}, []);

	const clearAll = useCallback(() => {
		setAttachedFiles([]);
		setAttachedImages([]);
		setCodeSnippets([]);
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
								setAttachedImages(prev => [...prev, { id, name: file.name, dataUrl, file }]);
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
					const processedPath = normalizePath(line);
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
		[addFile, postMessage],
	);

	// ── Paste ────────────────────────────────────────────────────────────
	// Only intercept when clipboard contains images. Text paste is never blocked.

	// Legacy compat: keep pendingPasteText so ChatInput can read it,
	// but it will always be null (paste is never blocked).
	const [pendingPasteText] = useState<string | null>(null);

	const handlePaste = useCallback((e: React.ClipboardEvent) => {
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
							setAttachedImages(prev => [...prev, { id, name: file.name, dataUrl, file }]);
						}
					};
					reader.readAsDataURL(file);
				}
				return;
			}
		}

		// 2. Text — let the browser handle the paste normally (no preventDefault!).
		//    Text is simply inserted into the input by the browser/CM6.
	}, []);

	// ── Extension message listener ───────────────────────────────────────

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;

			if (message?.type === 'imageData' && message.dataUrl) {
				const id = message.id || `img-${crypto.randomUUID()}`;
				const name = message.name || 'image.png';
				setAttachedImages(prev => [
					...prev,
					{ id, name, dataUrl: message.dataUrl, path: message.path },
				]);
			}

			if (message?.type === 'browsedFiles' && Array.isArray(message.paths)) {
				for (const filePath of message.paths as string[]) {
					const trimmed = filePath.trim();
					if (trimmed) {
						setAttachedFiles(prev => {
							if (prev.includes(trimmed)) return prev;
							return [...prev, trimmed];
						});
					}
				}
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	return {
		attachedFiles,
		attachedImages,
		codeSnippets,
		pendingPasteText,
		isDragOver,
		addFile,
		removeFile,
		removeImage,
		removeCodeSnippet,
		clearAll,
		clearPendingPaste: () => {},
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
	};
}
