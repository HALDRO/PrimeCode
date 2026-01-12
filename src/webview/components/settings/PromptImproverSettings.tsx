/**
 * @file PromptImproverSettings
 * @description Settings UI for the Prompt Improver feature. Displays timeout in seconds for UX,
 * while persisting the underlying extension setting in milliseconds (primeCode.promptImprove.timeoutMs).
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { useSettingsActions, useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { ChevronIcon } from '../icons';
import { Button, Select, TextArea } from '../ui';
import { GroupTitle, SettingRow, SettingsGroup } from './SettingsUI';

export const PromptImproverSettings: React.FC = () => {
	const {
		promptImproveModel,
		promptImproveTemplate,
		promptImproveTimeoutMs,
		proxyModels,
		enabledProxyModels,
		anthropicModels,
		disabledProviders,
	} = useSettingsStore();
	const { setSettings } = useSettingsActions();
	const { postMessage } = useVSCode();
	const [expanded, setExpanded] = useState(false);

	// Local state for timeout to allow instant UI updates
	const storeTimeoutSeconds =
		typeof promptImproveTimeoutMs === 'number' && Number.isFinite(promptImproveTimeoutMs)
			? Math.max(1, Math.round(promptImproveTimeoutMs))
			: 30;
	const [localTimeout, setLocalTimeout] = useState(storeTimeoutSeconds);
	const debounceRef = useRef<NodeJS.Timeout | null>(null);

	// Sync local state when store changes (e.g., from extension)
	useEffect(() => {
		setLocalTimeout(storeTimeoutSeconds);
	}, [storeTimeoutSeconds]);

	const saveSettingToBackend = useCallback(
		(key: string, value: unknown) => {
			let backendKey = '';
			if (key === 'promptImproveModel') {
				backendKey = 'promptImprove.model';
			}
			if (key === 'promptImproveTemplate') {
				backendKey = 'promptImprove.template';
			}
			if (key === 'promptImproveTimeoutMs') {
				backendKey = 'promptImprove.timeoutMs';
			}

			if (!backendKey) {
				return;
			}

			// Timeout is shown/stored in the webview as seconds for UX, but persisted as ms in extension.
			if (key === 'promptImproveTimeoutMs') {
				const seconds =
					typeof value === 'number'
						? value
						: typeof value === 'string'
							? Number.parseFloat(value)
							: Number.NaN;

				const ms = Number.isFinite(seconds) ? Math.max(1000, Math.round(seconds * 1000)) : 30000;

				postMessage('updateSettings', {
					settings: {
						[backendKey]: ms,
					},
				});
				return;
			}

			postMessage('updateSettings', {
				settings: {
					[backendKey]: value,
				},
			});
		},
		[postMessage],
	);

	const saveSetting = useCallback(
		(key: string, value: unknown) => {
			// Update local store immediately
			// biome-ignore lint/suspicious/noExplicitAny: generic setting update
			setSettings({ [key]: value } as any);
			// Save to backend
			saveSettingToBackend(key, value);
		},
		[setSettings, saveSettingToBackend],
	);

	// Debounced save for timeout - updates UI instantly, saves to backend after delay
	const handleTimeoutChange = useCallback(
		(secondsValue: number) => {
			const validValue = Number.isFinite(secondsValue) ? Math.max(1, secondsValue) : 30;

			// Update local state immediately for responsive UI
			setLocalTimeout(validValue);
			// Update store immediately too
			// biome-ignore lint/suspicious/noExplicitAny: generic setting update
			setSettings({ promptImproveTimeoutMs: validValue } as any);

			// Debounce the backend save
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => {
				saveSettingToBackend('promptImproveTimeoutMs', validValue);
			}, 500);
		},
		[setSettings, saveSettingToBackend],
	);

	// Cleanup debounce on unmount
	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
		};
	}, []);

	// Check if Anthropic provider is enabled
	const isAnthropicEnabled = !disabledProviders.includes('anthropic');

	const modelOptions = [
		{ value: '', label: 'Use main model' },
		// Anthropic Claude models (when available)
		...(isAnthropicEnabled
			? (anthropicModels.length > 0
					? anthropicModels
					: [
							{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
							{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
							{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
						]
				).map(m => ({ value: m.id, label: m.name }))
			: []),
		// OpenAI Compatible models
		...enabledProxyModels.map(id => {
			const model = proxyModels.find(m => m.id === id);
			return { value: id, label: model?.name || id };
		}),
	];

	const DEFAULT_TEMPLATE = `You are an expert prompt engineer. Your task is to rewrite the user's prompt to be more clear, specific, and effective for an LLM coding assistant.

CRITICAL RULES:
1.  Preserve the original intent and all technical details.
2.  Do NOT add any conversational filler ("Here is the improved prompt:", "Sure!").
3.  Output ONLY the improved prompt text.
4.  **detect the language of the user's prompt and output the improved prompt in the SAME language.** (e.g. Russian -> Russian).

User Prompt:
{{TEXT}}`;

	const currentTemplate = promptImproveTemplate || DEFAULT_TEMPLATE;

	return (
		<div className="animate-fade-in">
			<GroupTitle>Prompt Improver</GroupTitle>
			<SettingsGroup>
				<SettingRow title="Model" tooltip="Model used for improving prompts">
					<Select
						value={promptImproveModel}
						onChange={e => saveSetting('promptImproveModel', e.target.value)}
						options={modelOptions}
					/>
				</SettingRow>

				<div className="px-2.5 py-1.5 border-b border-(--border-subtle) last:border-b-0">
					<div className="flex items-center justify-between min-h-(--settings-row-height)">
						<span className="text-sm text-vscode-foreground">System Prompt Template</span>
						<div className="flex items-center gap-1.5">
							<Button
								size="xs"
								variant="secondary"
								onClick={() => saveSetting('promptImproveTemplate', DEFAULT_TEMPLATE)}
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
									'w-full bg-vscode-input-background border border-vscode-input-border rounded-sm p-1.5 text-sm font-mono mt-2',
									'focus:border-vscode-focusBorder focus:outline-none transition-all resize-none',
								)}
								placeholder={DEFAULT_TEMPLATE}
							/>
							<div className="mt-1.5 text-xs text-vscode-descriptionForeground">
								Use{' '}
								<code className="bg-(--alpha-10) px-1 rounded text-vscode-foreground">{`{{TEXT}}`}</code>{' '}
								placeholder for the user input.
							</div>
						</>
					)}
				</div>

				<SettingRow title="Timeout (sec)" tooltip="Max time to wait for improvement" last>
					<input
						type="number"
						min={1}
						max={300}
						value={localTimeout}
						onChange={e => {
							const secondsValue = Number.parseInt(e.target.value, 10);
							handleTimeoutChange(secondsValue);
						}}
						className="bg-vscode-input-background border border-vscode-input-border rounded-sm px-2 h-7 text-md text-vscode-input-foreground w-16 text-center focus:border-vscode-focusBorder focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
					/>
				</SettingRow>
			</SettingsGroup>
		</div>
	);
};
