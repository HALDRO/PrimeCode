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
import { getProxyEndpointProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from '../../../common';
import { cn } from '../../lib/cn';
import { useModelDropdownState, useModelSelection, useSessionModel } from '../../store';
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
		setSessionModel,
	} = useModelSelection();
	const { setShowModelDropdown } = useModelDropdownState();
	const sessionModel = useSessionModel();

	const sessionScopedModel = sessionModel;

	// Filter OpenCode models to only show enabled ones from non-disabled providers
	const filteredOpencodeProviders = useMemo(() => {
		// Filter each provider's models to only include enabled ones from non-disabled providers
		return (
			opencodeProviders
				// First filter out disabled providers and 'oai' (shown as OpenAI Compatible)
				.filter(provider => provider.id !== OPENAI_COMPATIBLE_PROVIDER_ID)
				.map(provider => ({
					...provider,
					models: provider.models.filter((model: { id: string; name: string }) => {
						const fullId = `${provider.id}/${model.id}`;
						return enabledOpenCodeModels.includes(fullId);
					}),
				}))
				.filter(provider => provider.models.length > 0)
		);
	}, [opencodeProviders, enabledOpenCodeModels]);

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
			setLastSelectedModel(model.id);
			// Persist per-session override (so different chats can use different models)
			setSessionModel(model.id === 'default' ? undefined : model.id);
			onClose();
		},
		[onClose, onSelectOverride, setLastSelectedModel, setSessionModel],
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
						'flex items-center gap-(--gap-1-5) pl-(--gap-4) pr-(--gap-3) py-0 my-px rounded-md cursor-pointer h-(--dropdown-item-height) text-sm leading-[1.2] transition-colors',
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
		// OpenCode models - flatten all providers into single list
		for (const opProvider of filteredOpencodeProviders) {
			for (const model of opProvider.models) {
				const modelId = `${opProvider.id}/${model.id}`;
				const isActive = activeModelForHighlight === modelId;
				result.push({
					id: modelId,
					label: model.name,
					icon: model.reasoning ? (
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
					meta: opProvider.name,
					data: {
						id: modelId,
						name: model.name,
						isActive,
						capabilities: { reasoning: model.reasoning === true },
					},
				});
			}
		}

		// Also add enabled proxy endpoint models for OpenCode
		for (const endpoint of proxyEndpoints) {
			if (!endpoint.enabledModels.length || !endpoint.models.length) continue;
			const providerId = getProxyEndpointProviderId(endpoint.id);
			for (const model of endpoint.models) {
				if (!endpoint.enabledModels.includes(model.id)) continue;
				const modelId = `${providerId}/${model.id}`;
				const isActive = activeModelForHighlight === modelId;
				const hasReasoning = model.capabilities?.reasoning === true;
				result.push({
					id: modelId,
					label: model.name || model.id,
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
					meta: endpoint.name || 'Custom',
					data: {
						id: modelId,
						name: model.name || model.id,
						isActive,
						capabilities: model.capabilities,
					},
				});
			}
		}

		return result;
	}, [activeModelForHighlight, filteredOpencodeProviders, proxyEndpoints, extraItems]);

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
