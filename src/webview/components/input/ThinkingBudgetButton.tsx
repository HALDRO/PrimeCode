/**
 * @file ThinkingBudgetButton — Dropdown selector for thinking effort variant
 * @description Compact icon-only button with signal-bar indicator showing current level.
 *              Variant options come dynamically from the model's `variants` field (from CLI).
 *              Hidden when the current model has no variants (non-reasoning models).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { getAvailableModelVariants, resolveValidVariant } from '../../lib/modelVariants';
import { useModelSelection, useSessionVariant } from '../../store';
import { useChatStore } from '../../store/chatStore';
import { ThinkingLevelIcon } from '../icons';
import { DropdownMenu } from '../ui';
import { GlowDot } from '../ui/GlowDot';

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Color mapping for the thinking level indicator dot on the button */
function getLevelDotColors(
	levelIndex: number,
	total: number,
): { color: string; glow: string } | undefined {
	if (total <= 0) return undefined;
	const ratio = total === 1 ? 1 : levelIndex / (total - 1);
	if (ratio <= 0.33) return { color: 'var(--color-success)', glow: 'var(--glow-success)' };
	if (ratio <= 0.66) return { color: 'var(--color-warning)', glow: 'var(--glow-warning)' };
	return { color: 'var(--color-error)', glow: 'var(--glow-error)' };
}

export const ThinkingBudgetButton: React.FC = React.memo(() => {
	const variant = useSessionVariant();
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const { opencodeProviders, selectedModel: globalModel, setModelVariant } = useModelSelection();
	const sessionModel = useChatStore(s => {
		const sid = s.activeSessionId;
		return sid ? s.sessionsById[sid]?.model : undefined;
	});
	const effectiveModel = sessionModel ?? globalModel;

	const variantNames = useMemo(() => {
		return getAvailableModelVariants(opencodeProviders, effectiveModel);
	}, [effectiveModel, opencodeProviders]);

	useEffect(() => {
		if (variant && !resolveValidVariant(variantNames, variant)) {
			if (effectiveModel && effectiveModel !== 'default') {
				setModelVariant(effectiveModel, undefined);
			}
		}
	}, [effectiveModel, setModelVariant, variant, variantNames]);

	const items = useMemo(
		() => [
			{ id: 'default', label: 'Default', data: undefined as string | undefined },
			...variantNames.map(name => ({
				id: name,
				label: capitalize(name),
				data: name as string | undefined,
			})),
		],
		[variantNames],
	);

	const handleSelect = useCallback(
		(value: string | undefined) => {
			if (!effectiveModel || effectiveModel === 'default') return;
			setModelVariant(effectiveModel, value);
			setIsOpen(false);
		},
		[effectiveModel, setModelVariant],
	);

	// Don't render if model has no variants
	if (variantNames.length === 0) return null;

	// Compute level index for the icon (undefined = default/no selection)
	const validatedVariant = resolveValidVariant(variantNames, variant);
	const levelIndex = validatedVariant ? variantNames.indexOf(validatedVariant) : undefined;
	const effectiveLevel = levelIndex !== undefined && levelIndex >= 0 ? levelIndex : undefined;
	const currentLabel = validatedVariant ? capitalize(validatedVariant) : 'Default';

	return (
		<div className="relative shrink-0">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				title={`Thinking effort: ${currentLabel}`}
				className={cn(
					'relative inline-flex items-center justify-center font-medium rounded cursor-pointer transition-all duration-200 select-none border-none bg-transparent focus:outline-none',
					'h-(--input-toolbar-height) w-(--input-toolbar-height)',
					'opacity-70 hover:opacity-100 hover:bg-(--alpha-5)',
					isOpen && 'bg-(--alpha-5) opacity-100',
				)}
			>
				<ThinkingLevelIcon size={13} level={effectiveLevel} total={variantNames.length} />
				{effectiveLevel !== undefined &&
					(() => {
						const dotColors = getLevelDotColors(effectiveLevel, variantNames.length);
						return dotColors ? (
							<span className="absolute top-[3px] right-[3px] pointer-events-none">
								<GlowDot color={dotColors.color} glow={dotColors.glow} size={4} />
							</span>
						) : null;
					})()}
			</button>
			{isOpen && (
				<DropdownMenu
					anchorElement={triggerRef.current}
					onClose={() => setIsOpen(false)}
					position="top"
					minWidth={120}
					maxWidth={180}
					items={items}
					onSelect={handleSelect}
					keyHints={{ navigate: true, select: true, close: true }}
					renderItem={(item, { hovered, onSelect, onHover }) => {
						const isSelected = item.data === validatedVariant;
						return (
							<div
								key={item.id}
								onClick={onSelect}
								onMouseEnter={onHover}
								className={cn(
									'flex items-center px-(--gap-3) py-(--gap-1) my-px rounded-md cursor-pointer h-(--dropdown-item-height) text-sm leading-[1.2] transition-colors hover:bg-(--alpha-8)',
									hovered ? 'bg-(--alpha-10) text-vscode-foreground' : 'text-(--alpha-70)',
									isSelected && 'text-(--color-accent) font-medium bg-(--color-accent)/10',
								)}
							>
								<span className="flex-1 whitespace-nowrap leading-[1.2]">{item.label}</span>
								{isSelected && (
									<div className="shrink-0 ml-(--gap-2)">
										<GlowDot color="var(--color-accent)" glow="var(--color-accent-glow)" size={4} />
									</div>
								)}
							</div>
						);
					}}
				/>
			)}
		</div>
	);
});
ThinkingBudgetButton.displayName = 'ThinkingBudgetButton';
