/**
 * @file ModelDropdown - AI model selector
 * @description Uses universal DropdownMenu for consistent styling. Shows standard Claude models,
 *              proxy models (OpenAI-compatible), and OpenCode provider models with active indicator.
 *              Only displays models that are explicitly enabled in settings (enabledProxyModels,
 *              enabledOpenCodeModels). Provider names displayed as badges. Active model indicated
 *              with purple glow dot. Supports both Claude and OpenCode providers.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '../../../shared';
import { cn } from '../../lib/cn';
import { useModelDropdownState, useModelSelection } from '../../store';
import { STANDARD_MODELS } from '../../utils/models';
import { useVSCode } from '../../utils/vscode';
import { BrainSideIcon, ZapIcon } from '../icons';
import { type DropdownItemRenderProps, DropdownMenu, type DropdownMenuItem, GlowDot } from '../ui';

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
}

export const ModelDropdown: React.FC<ModelDropdownProps> = ({
	anchorElement,
	onClose: externalOnClose,
}) => {
	const { postMessage } = useVSCode();
	const {
		provider,
		selectedModel,
		anthropicModels,
		anthropicModelsStatus,
		proxyModels,
		enabledProxyModels,
		opencodeProviders,
		enabledOpenCodeModels,
		disabledProviders,
	} = useModelSelection();
	const { setShowModelDropdown } = useModelDropdownState();

	// OpenAI-compatible provider ID used by settings/UI
	const OPENAI_COMPATIBLE_ID = OPENAI_COMPATIBLE_PROVIDER_ID;

	// Filter proxy models to only show enabled ones (and only if proxy provider is not disabled)
	const enabledProxyModelsList = useMemo(
		() =>
			disabledProviders.includes(OPENAI_COMPATIBLE_ID)
				? []
				: proxyModels.filter(m => enabledProxyModels.includes(m.id)),
		[proxyModels, enabledProxyModels, disabledProviders, OPENAI_COMPATIBLE_ID],
	);

	// Filter OpenCode models to only show enabled ones from non-disabled providers
	// Filter out 'oai' provider as it's shown separately via enabledProxyModelsList
	const filteredOpencodeProviders = useMemo(() => {
		// Filter each provider's models to only include enabled ones from non-disabled providers
		return (
			opencodeProviders
				// First filter out disabled providers and 'oai' (shown as OpenAI Compatible)
				.filter(
					provider =>
						!disabledProviders.includes(provider.id) &&
						provider.id !== OPENAI_COMPATIBLE_PROVIDER_ID,
				)
				.map(provider => ({
					...provider,
					models: provider.models.filter((model: { id: string; name: string }) => {
						const fullId = `${provider.id}/${model.id}`;
						return enabledOpenCodeModels.includes(fullId);
					}),
				}))
				.filter(provider => provider.models.length > 0)
		);
	}, [opencodeProviders, enabledOpenCodeModels, disabledProviders]);

	const onClose = useCallback(() => {
		setShowModelDropdown(false);
		externalOnClose?.();
	}, [setShowModelDropdown, externalOnClose]);

	const handleSelect = useCallback(
		(model: ModelData) => {
			if (provider === 'opencode') {
				postMessage('setOpenCodeModel', { model: model.id });
			} else {
				postMessage('selectModel', { model: model.id });
			}
			onClose();
		},
		[postMessage, onClose, provider],
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
						'flex items-center gap-(--gap-1-5) pl-(--gap-4) pr-(--gap-3) py-0 -mx-(--gap-2) rounded-sm cursor-pointer h-(--dropdown-item-height) text-sm leading-none transition-colors',
						item.disabled ? 'cursor-not-allowed opacity-50 text-(--alpha-30)' : 'text-(--alpha-90)',
						props.selected && !item.disabled && 'bg-(--alpha-10)',
						isSelected && 'text-(--color-accent) font-medium bg-(--color-accent)/10',
					)}
				>
					{item.icon && <span className="flex shrink-0 opacity-70">{item.icon}</span>}
					<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
						{item.label}
					</span>
					{item.data.capabilities?.reasoning && (
						<span className="flex shrink-0 items-center gap-(--gap-1) opacity-70 text-vscode-descriptionForeground">
							{isSelected && (
								<GlowDot color="var(--color-accent)" glow="var(--color-accent-glow)" size={4} />
							)}
							<BrainSideIcon size={14} />
						</span>
					)}
					{isSelected && !item.data.capabilities?.reasoning && (
						<div className="shrink-0 ml-(--gap-2)">
							<GlowDot color="var(--color-accent)" glow="var(--color-accent-glow)" size={4} />
						</div>
					)}
					{item.meta && <span className="shrink-0 text-xs text-(--alpha-40)">{item.meta}</span>}
				</div>
			);
		},
		[],
	);

	// Build flat list of models with provider as badge
	const items = useMemo((): DropdownMenuItem<ModelData>[] => {
		const result: DropdownMenuItem<ModelData>[] = [];

		if (provider === 'claude') {
			// Claude models (dynamic from Anthropic API when available, otherwise fallback list)
			const claudeModels =
				anthropicModelsStatus.success === true && anthropicModels.length > 0
					? anthropicModels
					: STANDARD_MODELS;

			for (const model of claudeModels) {
				const isActive = selectedModel === model.id;
				result.push({
					id: model.id,
					label: model.name,
					icon: (
						<ZapIcon
							size={14}
							style={{
								color: isActive ? 'var(--color-accent)' : 'var(--vscode-descriptionForeground)',
								opacity: isActive ? 1 : 0.7,
							}}
						/>
					),
					meta: 'Claude',
					data: { id: model.id, name: model.name, isActive },
				});
			}

			// Proxy models
			for (const model of enabledProxyModelsList) {
				const isActive = selectedModel === model.id;
				result.push({
					id: model.id,
					label: model.name || model.id,
					icon: (
						<ZapIcon
							size={14}
							style={{
								color: isActive ? 'var(--color-accent)' : 'var(--vscode-descriptionForeground)',
								opacity: isActive ? 1 : 0.7,
							}}
						/>
					),
					meta: 'OAI',
					data: {
						id: model.id,
						name: model.name || model.id,
						isActive,
						capabilities: model.capabilities,
					},
				});
			}
		} else if (provider === 'opencode') {
			// OpenCode models - flatten all providers into single list
			for (const opProvider of filteredOpencodeProviders) {
				for (const model of opProvider.models) {
					const modelId = `${opProvider.id}/${model.id}`;
					const isActive = selectedModel === modelId;
					result.push({
						id: modelId,
						label: model.name,
						icon: (
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

			// Also add enabled proxy models for OpenCode (OpenAI Compatible)
			for (const model of enabledProxyModelsList) {
				// For OpenCode, proxy models use 'oai' provider prefix (saved to opencode.json)
				const modelId = `${OPENAI_COMPATIBLE_PROVIDER_ID}/${model.id}`;
				const isActive = selectedModel === modelId;
				result.push({
					id: modelId,
					label: model.name || model.id,
					icon: (
						<ZapIcon
							size={14}
							style={{
								color: isActive ? 'var(--color-accent)' : 'var(--vscode-descriptionForeground)',
								opacity: isActive ? 1 : 0.7,
							}}
						/>
					),
					meta: 'OAI',
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
	}, [
		selectedModel,
		provider,
		enabledProxyModelsList,
		filteredOpencodeProviders,
		anthropicModels,
		anthropicModelsStatus.success,
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
