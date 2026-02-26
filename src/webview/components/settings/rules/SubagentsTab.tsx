/**
 * @file SubagentsTab.tsx
 * @description Settings tab for managing subagents stored in .opencode/agents/.
 *              Supports all OpenCode Agent fields: model, temperature, topP, mode,
 *              color, steps, tools, permission.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { DISPLAY_NAMES } from '../../../../common/toolRegistry';
import { useModelOptions } from '../../../hooks/useModelOptions';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { ChevronDownIcon, ChevronRightIcon, EditIcon, PlusIcon, TrashIcon } from '../../icons';
import { Button, Select, Switch, Tooltip } from '../../ui';
import {
	EmptyState,
	GroupTitle,
	SettingRow,
	SettingRowActions,
	SettingsBadge,
	SettingsGroup,
} from '../SettingsUI';

const KNOWN_TOOLS = Array.from(DISPLAY_NAMES.keys());
const MODE_OPTS = [
	{ value: '', label: 'Default' },
	{ value: 'subagent', label: 'Subagent' },
	{ value: 'primary', label: 'Primary' },
	{ value: 'all', label: 'All' },
];
const PERM_OPTS = [
	{ value: '', label: 'Default' },
	{ value: 'ask', label: 'Ask' },
	{ value: 'allow', label: 'Allow' },
	{ value: 'deny', label: 'Deny' },
];

interface FormState {
	name: string;
	description: string;
	content: string;
	model: string;
	temperature: string;
	topP: string;
	mode: string;
	color: string;
	steps: string;
	tools: Record<string, boolean>;
	perm: {
		edit: string;
		bash: string;
		webfetch: string;
		doom_loop: string;
		external_directory: string;
	};
}

// Default: all tools enabled (matches OpenCode CLI defaults)
const DEFAULT_TOOLS: Record<string, boolean> = Object.fromEntries(KNOWN_TOOLS.map(t => [t, true]));

const EMPTY: FormState = {
	name: '',
	description: '',
	content: '',
	model: '',
	temperature: '',
	topP: '',
	mode: '',
	color: '',
	steps: '',
	tools: { ...DEFAULT_TOOLS },
	perm: { edit: '', bash: '', webfetch: '', doom_loop: '', external_directory: '' },
};

const iCls =
	'w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder';

const Sec: React.FC<{
	title: string;
	open: boolean;
	toggle: () => void;
	children: React.ReactNode;
}> = ({ title, open, toggle, children }) => (
	<div className="border border-(--alpha-10) rounded">
		<button
			type="button"
			onClick={toggle}
			className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-vscode-descriptionForeground hover:bg-(--alpha-5) transition-colors"
		>
			{open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
			{title}
		</button>
		{open && <div className="px-2 pb-2 flex flex-col gap-2">{children}</div>}
	</div>
);

const Fl: React.FC<{ label: string; id: string; hint?: string; children: React.ReactNode }> = ({
	label,
	id,
	hint,
	children,
}) => (
	<div className="flex flex-col gap-0.5">
		<label htmlFor={id} className="text-xs text-vscode-descriptionForeground">
			{label}
			{hint && <span className="ml-1 opacity-60">({hint})</span>}
		</label>
		{children}
	</div>
);

export const SubagentsTab: React.FC = () => {
	const { subagents } = useSettingsStore();
	const { postMessage } = useVSCode();
	const modelOptions = useModelOptions();
	const [isCreating, setIsCreating] = useState(false);
	const [f, setF] = useState<FormState>(EMPTY);
	const [showAdv, setShowAdv] = useState(false);
	const [showTools, setShowTools] = useState(false);
	const [showPerm, setShowPerm] = useState(false);

	useEffect(() => {
		postMessage({ type: 'getSubagents' });
	}, [postMessage]);

	const upd = <K extends keyof FormState>(k: K, v: FormState[K]) => setF(p => ({ ...p, [k]: v }));
	const updPerm = (k: keyof FormState['perm'], v: string) =>
		setF(p => ({ ...p, perm: { ...p.perm, [k]: v } }));
	const togTool = (t: string) => setF(p => ({ ...p, tools: { ...p.tools, [t]: !p.tools[t] } }));
	const reset = () => {
		setIsCreating(false);
		setF(EMPTY);
		setShowAdv(false);
		setShowTools(false);
		setShowPerm(false);
	};

	const handleCreate = () => {
		if (!f.name || !f.content) return;
		// Only write disabled tools to config (enabled = CLI default, no need to specify)
		const disabledTools = Object.entries(f.tools).filter(([, v]) => !v);
		const tools: Record<string, boolean> | undefined =
			disabledTools.length > 0 ? Object.fromEntries(disabledTools) : undefined;
		const permObj: Record<string, string> = {};
		for (const [k, v] of Object.entries(f.perm)) {
			if (v) permObj[k] = v;
		}
		const permission = Object.keys(permObj).length > 0 ? permObj : undefined;
		const temp = f.temperature ? Number.parseFloat(f.temperature) : undefined;
		const topP = f.topP ? Number.parseFloat(f.topP) : undefined;
		const steps = f.steps ? Number.parseInt(f.steps, 10) : undefined;
		postMessage({
			type: 'createSubagent',
			name: f.name,
			description: f.description,
			content: f.content,
			...(f.model && { model: f.model }),
			...(temp !== undefined && !Number.isNaN(temp) && { temperature: temp }),
			...(topP !== undefined && !Number.isNaN(topP) && { topP }),
			...(f.mode && { mode: f.mode as 'subagent' | 'primary' | 'all' }),
			...(f.color && { color: f.color }),
			...(steps !== undefined && !Number.isNaN(steps) && { steps }),
			...(tools && { tools }),
			...(permission && { permission }),
		});
		reset();
	};

	return (
		<>
			<GroupTitle>Subagents</GroupTitle>
			<SettingsGroup>
				{!isCreating && (
					<SettingRow
						title="New Subagent"
						tooltip="Create a new subagent under .opencode/agents/"
						last
					>
						<Button size="sm" onClick={() => setIsCreating(true)}>
							<PlusIcon size={12} className="mr-1" />
							New
						</Button>
					</SettingRow>
				)}
			</SettingsGroup>

			{isCreating && (
				<SettingsGroup>
					<div className="p-3 flex flex-col gap-3 bg-(--alpha-5) rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-vscode-descriptionForeground">
							New Subagent
						</h3>
						<Fl label="Name" id="sa-name">
							<input
								id="sa-name"
								type="text"
								value={f.name}
								onChange={e => upd('name', e.target.value)}
								placeholder="e.g. research-codebase"
								className={iCls}
							/>
						</Fl>
						<Fl label="Description" id="sa-desc" hint="when to use this agent">
							<input
								id="sa-desc"
								type="text"
								value={f.description}
								onChange={e => upd('description', e.target.value)}
								placeholder="Description of what this subagent does"
								className={iCls}
							/>
						</Fl>
						<Fl label="Model" id="sa-model" hint="provider/model">
							<Select
								value={f.model}
								onChange={e => upd('model', e.target.value)}
								options={modelOptions}
							/>
						</Fl>
						<Fl label="Prompt Content" id="sa-content">
							<textarea
								id="sa-content"
								value={f.content}
								onChange={e => upd('content', e.target.value)}
								className={`${iCls} h-32 font-mono resize-y`}
								placeholder="Enter subagent prompt/instructions here..."
							/>
						</Fl>

						{/* Advanced Settings */}
						<Sec title="Advanced Settings" open={showAdv} toggle={() => setShowAdv(!showAdv)}>
							<div className="grid grid-cols-2 gap-2">
								<Fl label="Mode" id="sa-mode">
									<Select
										value={f.mode}
										onChange={e => upd('mode', e.target.value)}
										options={MODE_OPTS}
									/>
								</Fl>
								<Fl label="Color" id="sa-color" hint="hex">
									<input
										id="sa-color"
										type="text"
										value={f.color}
										onChange={e => upd('color', e.target.value)}
										placeholder="#FF5733"
										className={iCls}
									/>
								</Fl>
								<Fl label="Temperature" id="sa-temp" hint="0-2">
									<input
										id="sa-temp"
										type="number"
										step="0.1"
										min="0"
										max="2"
										value={f.temperature}
										onChange={e => upd('temperature', e.target.value)}
										placeholder="0.7"
										className={iCls}
									/>
								</Fl>
								<Fl label="Top P" id="sa-topp" hint="0-1">
									<input
										id="sa-topp"
										type="number"
										step="0.05"
										min="0"
										max="1"
										value={f.topP}
										onChange={e => upd('topP', e.target.value)}
										placeholder="0.9"
										className={iCls}
									/>
								</Fl>
								<Fl label="Max Steps" id="sa-steps">
									<input
										id="sa-steps"
										type="number"
										min="1"
										value={f.steps}
										onChange={e => upd('steps', e.target.value)}
										placeholder="50"
										className={iCls}
									/>
								</Fl>
							</div>
						</Sec>

						{/* Tools */}
						<Sec title="Tools" open={showTools} toggle={() => setShowTools(!showTools)}>
							<div className="grid grid-cols-3 gap-x-3 gap-y-1">
								{KNOWN_TOOLS.map(t => (
									<span
										key={t}
										className="flex items-center gap-1.5 text-xs text-vscode-foreground cursor-pointer py-0.5"
									>
										<Switch checked={!!f.tools[t]} onChange={() => togTool(t)} />
										{DISPLAY_NAMES.get(t) ?? t}
									</span>
								))}
							</div>
						</Sec>

						{/* Permissions */}
						<Sec title="Permissions" open={showPerm} toggle={() => setShowPerm(!showPerm)}>
							<div className="grid grid-cols-2 gap-2">
								{(['edit', 'bash', 'webfetch', 'doom_loop', 'external_directory'] as const).map(
									k => (
										<Fl key={k} label={k.replace('_', ' ')} id={`sa-perm-${k}`}>
											<Select
												value={f.perm[k]}
												onChange={e => updPerm(k, e.target.value)}
												options={PERM_OPTS}
											/>
										</Fl>
									),
								)}
							</div>
						</Sec>

						<div className="flex justify-end gap-2 mt-2">
							<Button size="sm" variant="secondary" onClick={reset}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleCreate} disabled={!f.name || !f.content}>
								Create
							</Button>
						</div>
					</div>
				</SettingsGroup>
			)}

			{/* Subagents List */}
			<SettingsGroup>
				{subagents.isLoading ? (
					<div className="p-4 text-center text-vscode-descriptionForeground text-xs">
						Loading subagents...
					</div>
				) : subagents.items.length === 0 ? (
					<EmptyState>No subagents found. Create one above.</EmptyState>
				) : (
					subagents.items.map((sa, idx) => (
						<SettingRow
							key={sa.name}
							title={`@${sa.name}`}
							tooltip={sa.description || sa.path}
							last={idx === subagents.items.length - 1}
						>
							<SettingRowActions>
								{sa.model && (
									<SettingsBadge variant="blue">{sa.model.split('/').pop()}</SettingsBadge>
								)}
								{sa.mode && <SettingsBadge>{sa.mode}</SettingsBadge>}
								<Tooltip content="Edit file" position="top" delay={200}>
									<button
										type="button"
										onClick={() => postMessage({ type: 'openSubagentFile', name: sa.name })}
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<Tooltip content="Delete" position="top" delay={200}>
									<button
										type="button"
										onClick={() => postMessage({ type: 'deleteSubagent', name: sa.name })}
										className="p-1 rounded hover:bg-vscode-errorForeground/20 text-vscode-descriptionForeground hover:text-vscode-errorForeground transition-colors"
									>
										<TrashIcon size={12} />
									</button>
								</Tooltip>
							</SettingRowActions>
						</SettingRow>
					))
				)}
			</SettingsGroup>
		</>
	);
};
