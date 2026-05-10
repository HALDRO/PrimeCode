/**
 * @file ModelDropdown - AI model selector
 * @description Uses universal DropdownMenu for consistent styling. Shows standard models,
 *              proxy models (OpenAI-compatible), and OpenCode provider models with active indicator.
 *              Only displays models that are explicitly enabled in settings (enabledProxyModels,
 *              enabledOpenCodeModels). Provider names displayed as badges. Active model indicated
 *              with purple glow dot. Supports multiple providers.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { parseModelId } from '../../../common';
import { buildModelOptions } from '../../hooks/useModelOptions';
import { cn } from '../../lib/cn';
import { useModelDropdownState, useModelSelection, useSessionModel } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { BrainSideIcon, ZapIcon } from '../icons';
import { type DropdownItemRenderProps, DropdownMenu, type DropdownMenuItem } from '../ui';

interface ModelData {
	id: string;
	name: string;
	isActive?: boolean;
	capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
}

interface ModelDropdownProps {
	/** Anchor element for positioning */
	anchorElement?: HTMLElement | null;
	/** Optional callback when dropdown should close */
	onClose?: () => void;
	/** Override default select behaviour (e.g. for settings). Receives composite model id. */
	onSelectOverride?: (modelId: string) => void;
	/** Override which model id is shown as active (e.g. promptImproveModel in settings) */
	activeModelId?: string;
	/** Prepend extra items (e.g. "Use main model") */
	extraItems?: DropdownMenuItem<ModelData>[];
}

export type { ModelData };

export const ModelDropdown: React.FC<ModelDropdownProps> = ({
	anchorElement,
	onClose: externalOnClose,
	onSelectOverride,
	activeModelId,
	extraItems,
}) => {
	const {
		proxyEndpoints,
		opencodeProviders,
		enabledOpenCodeModels,
		setLastSelectedModel,
		providerModelVisibility,
		setSessionModel,
	} = useModelSelection();
	const { setShowModelDropdown } = useModelDropdownState();
	const { postMessage } = useVSCode();
	const sessionModel = useSessionModel();

	const sessionScopedModel = sessionModel;

	const onClose = useCallback(() => {
		setShowModelDropdown(false);
		externalOnClose?.();
	}, [setShowModelDropdown, externalOnClose]);

	const handleSelect = useCallback(
		(model: ModelData) => {
			if (onSelectOverride) {
				onSelectOverride(model.id);
				onClose();
				return;
			}
			if (!parseModelId(model.id)) {
				onClose();
				return;
			}
			setLastSelectedModel(model.id);
			// Persist per-session override (so different chats can use different models)
			setSessionModel(model.id);
			postMessage({ type: 'setOpenCodeModel', model: model.id });
			onClose();
		},
		[onClose, onSelectOverride, postMessage, setLastSelectedModel, setSessionModel],
	);

	// Custom render for model items with purple dot for active model
	const renderModelItem = useCallback(
		(item: DropdownMenuItem<ModelData>, props: DropdownItemRenderProps) => {
			const isSelected = item.data.isActive;
			return (
				<div
					key={item.id}
					onClick={props.onSelect}
					onMouseEnter={props.onHover}
					className={cn(
						'flex items-center gap-(--gap-1-5) px-(--gap-3) py-0 my-px rounded-md cursor-pointer h-(--dropdown-item-height) text-sm leading-[1.2] transition-colors',
						item.disabled
							? 'cursor-not-allowed opacity-50 text-(--alpha-30)'
							: 'text-(--alpha-90) hover:bg-(--alpha-8)',
						props.selected && !item.disabled && 'bg-(--alpha-10)',
						isSelected && 'text-(--color-accent) font-medium bg-(--color-accent)/10',
					)}
				>
					{item.icon && <span className="flex shrink-0 opacity-70">{item.icon}</span>}
					<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-[1.2]">
						{item.label}
					</span>
					{item.meta && (
						<span className="shrink-0 text-xs text-(--alpha-40) leading-[1.2]">{item.meta}</span>
					)}
				</div>
			);
		},
		[],
	);

	// Resolve which model id to use for "active" highlighting
	const activeModelForHighlight = activeModelId ?? sessionScopedModel;

	// Build flat list of models with provider as badge
	const items = useMemo((): DropdownMenuItem<ModelData>[] => {
		const result: DropdownMenuItem<ModelData>[] = [...(extraItems ?? [])];
		const visibleProviders = opencodeProviders.filter(
			provider => providerModelVisibility[provider.id] !== false,
		);
		const visibleEndpoints = proxyEndpoints;
		const modelOptions = buildModelOptions({
			opencodeProviders: visibleProviders,
			enabledOpenCodeModels,
			proxyEndpoints: visibleEndpoints,
			providerModelVisibility,
			includeDefault: false,
		});

		for (const option of modelOptions) {
			const isActive = activeModelForHighlight === option.value;
			const hasReasoning = option.reasoning === true;
			const label = option.modelLabel ?? option.label;
			result.push({
				id: option.value,
				label,
				icon: hasReasoning ? (
					<BrainSideIcon
						size={14}
						style={{
							color: isActive ? 'var(--color-accent)' : 'var(--vscode-descriptionForeground)',
							opacity: isActive ? 1 : 0.7,
						}}
					/>
				) : (
					<ZapIcon
						size={14}
						style={{
							color: isActive ? 'var(--color-accent)' : 'var(--vscode-descriptionForeground)',
							opacity: isActive ? 1 : 0.7,
						}}
					/>
				),
				meta: option.providerLabel,
				data: {
					id: option.value,
					name: label,
					isActive,
					capabilities: { reasoning: hasReasoning },
				},
			});
		}

		return result;
	}, [
		activeModelForHighlight,
		enabledOpenCodeModels,
		extraItems,
		opencodeProviders,
		providerModelVisibility,
		proxyEndpoints,
	]);

	return (
		<DropdownMenu
			items={items}
			onSelect={handleSelect}
			onClose={onClose}
			renderItem={renderModelItem}
			keyHints={{}}
			position="top"
			minWidth={260}
			maxWidth={300}
			anchorElement={anchorElement}
		/>
	);
};
