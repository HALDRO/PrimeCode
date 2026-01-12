/**
 * @file DropdownMenu - Universal dropdown menu component
 * @description Simple and reliable dropdown using fixed positioning + portal rendering via @floating-ui/react.
 *              Supports positioning relative to a real DOM anchor element or an explicit anchor rect.
 *              Features: optional search, sections, keyboard navigation, custom item rendering.
 *              Height is adaptive: uses viewport-relative units (vh) with pixel fallback.
 */

import {
	autoUpdate,
	flip,
	offset,
	shift,
	useDismiss,
	useFloating,
	useInteractions,
	type VirtualElement,
} from '@floating-ui/react';
import type React from 'react';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { ScrollContainer } from './ScrollContainer';
import { Tooltip } from './Tooltip';

type DropdownPosition = 'top' | 'bottom';
type DropdownAlign = 'left' | 'right';

/* =============================================================================
   POSITIONING UTILITIES
   ============================================================================= */

export type AnchorRectLike = Pick<
	DOMRect,
	'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'
>;

/* =============================================================================
   INTERNAL CONTAINER
   ============================================================================= */

interface DropdownContainerProps {
	children: ReactNode;
	onClose: () => void;
	position: DropdownPosition;
	align: DropdownAlign;
	width?: number;
	minWidth: number;
	maxWidth: number;
	/** Max height in pixels (fallback/cap). */
	maxHeight: number;
	/** Max height as percentage of viewport height (0-100). */
	maxHeightVh: number;
	/** Anchor element for positioning - REQUIRED */
	anchorElement: HTMLElement | null;
	/** Optional explicit anchor rect override. */
	anchorRect?: AnchorRectLike | null;
}

const DropdownContainer: React.FC<DropdownContainerProps> = ({
	children,
	onClose,
	position,
	align,
	width,
	minWidth,
	maxWidth,
	maxHeight,
	maxHeightVh,
	anchorElement,
	anchorRect,
}) => {
	const hasAnimatedRef = useRef(false);
	const [isVisible, setIsVisible] = useState(false);
	const [transitionEnabled, setTransitionEnabled] = useState(true);

	const computedMaxHeight = useMemo(() => {
		const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
		const vhBasedHeight = (viewportHeight * maxHeightVh) / 100;
		return Math.max(Math.min(vhBasedHeight, maxHeight), 200);
	}, [maxHeight, maxHeightVh]);

	const placement = useMemo(() => {
		const base = position === 'top' ? 'top' : 'bottom';
		const side = align === 'right' ? 'end' : 'start';
		return `${base}-${side}` as const;
	}, [position, align]);

	const reference = useMemo((): VirtualElement | HTMLElement | null => {
		if (!anchorElement) {
			return null;
		}
		if (!anchorRect) {
			return anchorElement;
		}
		const rect = anchorRect;
		return {
			getBoundingClientRect: () =>
				new DOMRect(
					rect.left,
					rect.top,
					rect.width ?? rect.right - rect.left,
					rect.height ?? rect.bottom - rect.top,
				),
		};
	}, [anchorElement, anchorRect]);

	const { refs, floatingStyles, context, x, y, update } = useFloating({
		open: true,
		onOpenChange: open => {
			if (!open) {
				onClose();
			}
		},
		elements: { reference: anchorElement },
		placement,
		strategy: 'fixed',
		whileElementsMounted: (refEl, floatEl, update) =>
			autoUpdate(refEl, floatEl, update, { animationFrame: false }),
		middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
	});

	const dismiss = useDismiss(context, {
		escapeKey: true,
		outsidePress: event => {
			const target = event.target as Node | null;
			if (!target) {
				return true;
			}
			if (anchorElement?.contains(target)) {
				return false;
			}
			return true;
		},
	});

	const { getFloatingProps } = useInteractions([dismiss]);

	const handleSetFloating = useCallback(
		(node: HTMLDivElement | null) => refs.setFloating(node),
		[refs],
	);

	useLayoutEffect(() => {
		if (!anchorElement) {
			return;
		}
		refs.setPositionReference(reference && reference !== anchorElement ? reference : null);
		update();
	}, [anchorElement, reference, refs, update]);

	useEffect(() => {
		if (x != null && y != null && refs.floating.current && !hasAnimatedRef.current) {
			hasAnimatedRef.current = true;
			setIsVisible(true);
		}
	}, [refs.floating, x, y]);

	useEffect(() => {
		if (!isVisible || !transitionEnabled) {
			return;
		}
		const timeout = window.setTimeout(() => setTransitionEnabled(false), 120);
		return () => window.clearTimeout(timeout);
	}, [isVisible, transitionEnabled]);

	if (!anchorElement) {
		return null;
	}

	const transformOrigin = position === 'top' ? 'bottom center' : 'top center';

	return createPortal(
		<div
			ref={handleSetFloating}
			{...getFloatingProps()}
			style={
				{
					position: 'fixed',
					...floatingStyles,
					['--dd-width' as string]: width ? `${width}px` : undefined,
					['--dd-minw' as string]: `${minWidth}px`,
					['--dd-maxw' as string]: `${maxWidth}px`,
					['--dd-maxh' as string]: `${computedMaxHeight}px`,
					transformOrigin,
					maxWidth: `min(${maxWidth}px, calc(100vw - 24px))`,
					minWidth: `min(${minWidth}px, calc(100vw - 24px))`,
				} as React.CSSProperties
			}
			className={cn(
				'dropdown-menu z-10000 flex flex-col overflow-hidden',
				'w-(--dd-width) min-w-(--dd-minw) max-w-(--dd-maxw) max-h-(--dd-maxh)',
				'bg-(--card-bg-light) border border-white/10 rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.5)]',
				transitionEnabled && 'transition-[opacity,scale] duration-120 ease-out',
				isVisible ? 'visible opacity-100 scale-100' : 'invisible opacity-0 scale-96',
			)}
		>
			{children}
		</div>,
		document.body,
	);
};

/* =============================================================================
   WRAPPER FOR AUTO-ANCHOR DETECTION
   ============================================================================= */

interface DropdownWrapperProps extends Omit<DropdownContainerProps, 'anchorElement'> {
	anchorElement?: HTMLElement | null;
}

const DropdownWrapper: React.FC<DropdownWrapperProps> = ({
	anchorElement,
	maxHeightVh,
	...props
}) => {
	const markerRef = useRef<HTMLDivElement>(null);
	const [detectedAnchor, setDetectedAnchor] = useState<HTMLElement | null>(null);

	useLayoutEffect(() => {
		if (anchorElement) {
			return;
		}
		const marker = markerRef.current;
		if (!marker) {
			return;
		}

		const prev = marker.previousElementSibling;
		if (prev instanceof HTMLElement) {
			setDetectedAnchor(prev);
			return;
		}

		if (marker.parentElement) {
			setDetectedAnchor(marker.parentElement);
		}
	}, [anchorElement]);

	const finalAnchor = anchorElement ?? detectedAnchor;

	return (
		<>
			{!anchorElement && (
				<div
					ref={markerRef}
					style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
				/>
			)}
			{finalAnchor && (
				<DropdownContainer {...props} maxHeightVh={maxHeightVh} anchorElement={finalAnchor} />
			)}
		</>
	);
};

/* =============================================================================
   PUBLIC API
   ============================================================================= */

export interface DropdownMenuItem<T = unknown> {
	id: string;
	label: string;
	description?: string;
	icon?: ReactNode;
	meta?: string;
	disabled?: boolean;
	danger?: boolean;
	data: T;
}

export interface DropdownMenuSection<T = unknown> {
	title?: string;
	action?: ReactNode;
	items: DropdownMenuItem<T>[];
}

export interface DropdownKeyHints {
	navigate?: boolean;
	select?: boolean;
	rename?: boolean;
	delete?: boolean;
	close?: boolean;
}

export interface DropdownItemRenderProps {
	selected: boolean;
	hovered: boolean;
	onSelect: () => void;
	onHover: () => void;
}

interface DropdownMenuProps<T> {
	title?: string;
	headerAction?: ReactNode;
	items?: DropdownMenuItem<T>[];
	sections?: DropdownMenuSection<T>[];
	searchable?: boolean;
	searchPlaceholder?: string;
	searchValue?: string;
	onSearchChange?: (value: string) => void;
	searchAutoFocus?: boolean;
	searchReadOnly?: boolean;
	onSelect: (item: T) => void;
	onClose: () => void;
	onRename?: (item: T) => void;
	onDelete?: (item: T) => void;
	keyHints?: DropdownKeyHints;
	footer?: ReactNode;
	loading?: boolean;
	emptyMessage?: string;
	position?: DropdownPosition;
	align?: DropdownAlign;
	width?: number;
	minWidth?: number;
	maxWidth?: number;
	maxHeight?: number;
	maxHeightVh?: number;
	renderItem?: (item: DropdownMenuItem<T>, props: DropdownItemRenderProps) => ReactNode;
	anchorElement?: HTMLElement | null;
	anchorRect?: AnchorRectLike | null;
	disableKeyboardNav?: boolean;
}

export function DropdownMenu<T>({
	title,
	headerAction,
	items,
	sections,
	searchable = false,
	searchPlaceholder = 'Search...',
	searchValue,
	onSearchChange,
	searchAutoFocus = false,
	searchReadOnly = false,
	onSelect,
	onClose,
	onRename,
	onDelete,
	keyHints = { navigate: true, select: true, close: true },
	footer,
	loading = false,
	emptyMessage = 'No items',
	position = 'bottom',
	align = 'left',
	width,
	minWidth = 240,
	maxWidth = 340,
	maxHeight = 720,
	maxHeightVh = 70,
	renderItem,
	anchorElement,
	anchorRect,
	disableKeyboardNav = false,
}: DropdownMenuProps<T>) {
	const [internalSearch, setInternalSearch] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

	const effectiveSearch = searchValue ?? internalSearch;
	const allItems = sections ? sections.flatMap(s => s.items) : items || [];

	const filteredItems = effectiveSearch.trim()
		? allItems.filter(item => item.label.toLowerCase().includes(effectiveSearch.toLowerCase()))
		: allItems;

	const filteredSections = sections
		? sections
				.map(s => ({
					...s,
					items: s.items.filter(
						item =>
							!effectiveSearch.trim() ||
							item.label.toLowerCase().includes(effectiveSearch.toLowerCase()),
					),
				}))
				.filter(s => s.items.length > 0)
		: null;

	useEffect(() => {
		if (selectedIndex >= filteredItems.length) {
			setSelectedIndex(Math.max(0, filteredItems.length - 1));
		}
	}, [filteredItems.length, selectedIndex]);

	useEffect(() => {
		if (disableKeyboardNav) {
			return;
		}
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!filteredItems.length) {
				return;
			}

			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					setSelectedIndex(prev => Math.min(prev + 1, filteredItems.length - 1));
					break;
				case 'ArrowUp':
					e.preventDefault();
					setSelectedIndex(prev => Math.max(prev - 1, 0));
					break;
				case 'Enter': {
					e.preventDefault();
					const item = filteredItems[selectedIndex];
					if (item && !item.disabled) {
						onSelect(item.data);
					}
					break;
				}
				case 'F2':
					if (onRename) {
						e.preventDefault();
						const item = filteredItems[selectedIndex];
						if (item) {
							onRename(item.data);
						}
					}
					break;
				case 'Delete':
					if (onDelete) {
						e.preventDefault();
						const item = filteredItems[selectedIndex];
						if (item) {
							onDelete(item.data);
						}
					}
					break;
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [filteredItems, selectedIndex, onSelect, onRename, onDelete, disableKeyboardNav]);

	const renderMenuItem = (item: DropdownMenuItem<T>, index: number) => {
		const isSelected = index === selectedIndex;
		const isHovered = index === hoveredIndex;

		if (renderItem) {
			return renderItem(item, {
				selected: isSelected,
				hovered: isHovered,
				onSelect: () => !item.disabled && onSelect(item.data),
				onHover: () => {
					setSelectedIndex(index);
					setHoveredIndex(index);
				},
			});
		}

		return (
			<div
				key={item.id}
				onClick={() => !item.disabled && onSelect(item.data)}
				onMouseEnter={() => {
					setSelectedIndex(index);
					setHoveredIndex(index);
				}}
				onMouseLeave={() => setHoveredIndex(null)}
				className={cn(
					'flex items-center gap-(--gap-1-5) pl-(--gap-4) pr-(--gap-3) py-0 -mx-(--gap-2) rounded-sm cursor-pointer h-(--dropdown-item-height) text-sm leading-none',
					item.disabled
						? 'cursor-not-allowed opacity-50 text-(--alpha-30)'
						: item.danger
							? 'text-error'
							: 'text-(--alpha-90)',
					isSelected && !item.disabled && 'bg-(--alpha-10)',
				)}
			>
				{item.description ? (
					<Tooltip
						content={item.description}
						position="right"
						delay={150}
						display="block"
						wrapperStyle={{ width: '100%' }}
					>
						<div className="flex items-center gap-(--gap-1-5) w-full">
							{item.icon && <span className="flex shrink-0 opacity-70">{item.icon}</span>}
							<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
								{item.label}
							</span>
							{item.meta && <span className="shrink-0 text-(--alpha-40)">{item.meta}</span>}
						</div>
					</Tooltip>
				) : (
					<>
						{item.icon && <span className="flex shrink-0 opacity-70">{item.icon}</span>}
						<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
							{item.label}
						</span>
						{item.meta && <span className="shrink-0 text-(--alpha-40)">{item.meta}</span>}
					</>
				)}
			</div>
		);
	};

	const hints: { keys: string; label: string }[] = [];
	if (keyHints.navigate) {
		hints.push({ keys: '↑↓', label: 'Navigate' });
	}
	if (keyHints.select) {
		hints.push({ keys: '↵', label: 'Select' });
	}
	if (keyHints.rename && onRename) {
		hints.push({ keys: 'F2', label: 'Rename' });
	}
	if (keyHints.delete && onDelete) {
		hints.push({ keys: 'Del', label: 'Delete' });
	}
	if (keyHints.close) {
		hints.push({ keys: 'Esc', label: 'Close' });
	}

	let globalIndex = 0;

	return (
		<DropdownWrapper
			onClose={onClose}
			position={position}
			align={align}
			width={width}
			minWidth={minWidth}
			maxWidth={maxWidth}
			maxHeight={maxHeight}
			maxHeightVh={maxHeightVh}
			anchorElement={anchorElement}
			anchorRect={anchorRect}
		>
			{searchable && (
				<div className="flex items-center shrink-0 h-(--tool-header-height) min-h-(--tool-header-height) px-(--dropdown-padding-x) border-b border-(--alpha-5)">
					<input
						type="text"
						value={effectiveSearch}
						readOnly={searchReadOnly}
						onChange={e => {
							const next = e.target.value;
							onSearchChange?.(next);
							if (searchValue === undefined) {
								setInternalSearch(next);
							}
						}}
						placeholder={searchPlaceholder}
						// biome-ignore lint/a11y/noAutofocus: intentional UI behavior for search focus
						autoFocus={searchAutoFocus}
						className={cn(
							'w-full bg-transparent border-none p-0 outline-none box-border',
							'text-sm text-(--alpha-90) placeholder:text-(--alpha-30)',
							searchReadOnly && 'opacity-70',
						)}
					/>
				</div>
			)}

			{title && (
				<div className="flex items-center justify-between shrink-0 h-(--tool-header-height) min-h-(--tool-header-height) px-(--dropdown-padding-x) border-b border-(--alpha-10) text-xs font-semibold text-(--alpha-50) uppercase tracking-[0.5px]">
					<span>{title}</span>
					{headerAction}
				</div>
			)}

			<ScrollContainer className="flex-1 py-(--gap-1) px-(--gap-3)" autoHide="never">
				{loading ? (
					<div className="p-(--gap-4) text-center text-sm text-(--alpha-50)">Loading...</div>
				) : filteredItems.length === 0 ? (
					<div className="p-(--gap-4) text-center text-sm text-(--alpha-50)">{emptyMessage}</div>
				) : filteredSections ? (
					filteredSections.map((section, sectionIdx) => (
						<div key={section.title || sectionIdx}>
							{section.title && (
								<div className="flex items-center justify-between px-(--dropdown-padding-x) pt-(--gap-1) pb-(--gap-0-5) text-xs font-medium text-(--alpha-40)">
									<span>{section.title}</span>
									{section.action}
								</div>
							)}
							{section.items.map(item => {
								const idx = globalIndex++;
								return renderMenuItem(item, idx);
							})}
						</div>
					))
				) : (
					filteredItems.map((item, idx) => renderMenuItem(item, idx))
				)}
			</ScrollContainer>

			{footer && <div className="border-t border-(--alpha-10)">{footer}</div>}

			{hints.length > 0 && (
				<div className="flex gap-(--gap-2-5) px-(--dropdown-padding-x) py-(--gap-1) border-t border-(--alpha-10) text-xs text-(--alpha-40) h-(--dropdown-footer-height) box-border items-center">
					{hints.map(hint => (
						<span key={hint.keys} className="flex items-center gap-(--gap-1)">
							<kbd className="text-2xs text-(--alpha-50)">{hint.keys}</kbd>
							<span>{hint.label}</span>
						</span>
					))}
				</div>
			)}
		</DropdownWrapper>
	);
}
