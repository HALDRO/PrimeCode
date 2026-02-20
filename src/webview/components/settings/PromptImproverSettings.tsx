/**
 * @file PromptImproverSettings
 * @description Settings UI for the Prompt Improver feature (model selection and system prompt template).
 *              Reuses ModelDropdown for model selection to avoid duplicating model list logic.
 */

import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { resolveModelDisplayName } from '../../../common';
import { IMPROVE_PROMPT_DEFAULT_TEMPLATE } from '../../../common/promptImprover';
import { cn } from '../../lib/cn';
import { useSettingsActions, useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { ChevronIcon } from '../icons';
import { type ModelData, ModelDropdown } from '../input/ModelDropdown';
import { Button, type DropdownMenuItem, TextArea } from '../ui';
import { GroupTitle, SettingRow, SettingsGroup } from './SettingsUI';

export const PromptImproverSettings: React.FC = () => {
	const { promptImproveModel, promptImproveTemplate, opencodeProviders, proxyModels } =
		useSettingsStore();
	const { setSettings } = useSettingsActions();
	const { postMessage } = useVSCode();
	const [expanded, setExpanded] = useState(false);
	const [showModelDropdown, setShowModelDropdown] = useState(false);
	const modelButtonRef = useRef<HTMLButtonElement>(null);

	const saveSettingToBackend = useCallback(
		(key: string, value: unknown) => {
			const keyMap: Record<string, string> = {
				promptImproveModel: 'promptImprove.model',
				promptImproveTemplate: 'promptImprove.template',
			};
			const backendKey = keyMap[key];
			if (!backendKey) return;
			postMessage({ type: 'updateSettings', settings: { [backendKey]: value } });
		},
		[postMessage],
	);

	const saveSetting = useCallback(
		(key: string, value: unknown) => {
			// biome-ignore lint/suspicious/noExplicitAny: generic setting update
			setSettings({ [key]: value } as any);
			saveSettingToBackend(key, value);
		},
		[setSettings, saveSettingToBackend],
	);

	// "Use main model" extra item prepended to the dropdown
	const extraItems = useMemo((): DropdownMenuItem<ModelData>[] => {
		const isActive = !promptImproveModel;
		return [
			{
				id: '',
				label: 'Use main model',
				data: { id: '', name: 'Use main model', isActive },
			},
		];
	}, [promptImproveModel]);

	const handleModelSelect = useCallback(
		(modelId: string) => {
			saveSetting('promptImproveModel', modelId);
		},
		[saveSetting],
	);

	const selectedModelLabel = useMemo(() => {
		if (!promptImproveModel) return 'Use main model';
		return resolveModelDisplayName(promptImproveModel, opencodeProviders, proxyModels);
	}, [promptImproveModel, opencodeProviders, proxyModels]);

	const currentTemplate = promptImproveTemplate || IMPROVE_PROMPT_DEFAULT_TEMPLATE;

	return (
		<div className="animate-fade-in">
			<GroupTitle>Prompt Improver</GroupTitle>
			<SettingsGroup>
				<SettingRow title="Model" tooltip="Model used for improving prompts">
					<div className="relative">
						<button
							ref={modelButtonRef}
							type="button"
							onClick={() => setShowModelDropdown(!showModelDropdown)}
							className={cn(
								'flex items-center justify-between gap-(--gap-2) px-(--gap-2-5) h-(--btn-height-sm) min-w-(--select-min-width) rounded-md bg-(--alpha-5) border border-(--alpha-10) text-sm text-(--alpha-90) cursor-pointer outline-none transition-all duration-200',
								'hover:bg-(--alpha-8) hover:border-(--alpha-20)',
								showModelDropdown &&
									'border-(--color-accent)/50 bg-(--alpha-10) ring-1 ring-(--color-accent)/20',
							)}
						>
							<span className="truncate">{selectedModelLabel}</span>
							<ChevronIcon expanded={showModelDropdown} size={10} className="shrink-0" />
						</button>
						{showModelDropdown && (
							<ModelDropdown
								anchorElement={modelButtonRef.current}
								onClose={() => setShowModelDropdown(false)}
								onSelectOverride={handleModelSelect}
								activeModelId={promptImproveModel || ''}
								extraItems={extraItems}
							/>
						)}
					</div>
				</SettingRow>

				<div className="px-2.5 py-1.5 border-b border-(--border-subtle) last:border-b-0">
					<div className="flex items-center justify-between min-h-(--settings-row-height)">
						<span className="text-sm text-vscode-foreground">System Prompt Template</span>
						<div className="flex items-center gap-1.5">
							<Button
								size="xs"
								variant="secondary"
								onClick={() =>
									saveSetting('promptImproveTemplate', IMPROVE_PROMPT_DEFAULT_TEMPLATE)
								}
							>
								Reset Default
							</Button>
							<Button
								size="xs"
								variant="ghost"
								onClick={() => setExpanded(!expanded)}
								className="flex items-center gap-1"
							>
								{expanded ? 'Collapse' : 'Expand'}
								<ChevronIcon expanded={expanded} size={12} />
							</Button>
						</div>
					</div>
					{expanded && (
						<>
							<TextArea
								value={currentTemplate}
								onChange={e => saveSetting('promptImproveTemplate', e.target.value)}
								rows={15}
								className={cn(
									'w-full bg-vscode-input-background border border-vscode-input-border rounded p-1.5 text-sm font-mono mt-2',
									'focus:border-vscode-focusBorder focus:outline-none transition-all resize-none',
								)}
								placeholder={IMPROVE_PROMPT_DEFAULT_TEMPLATE}
							/>
							<div className="mt-1.5 text-xs text-vscode-descriptionForeground">
								Use{' '}
								<code className="bg-(--alpha-10) px-1 rounded text-vscode-foreground">{`{{TEXT}}`}</code>{' '}
								placeholder for the user input.
							</div>
						</>
					)}
				</div>
			</SettingsGroup>
		</div>
	);
};
