/**
 * @file AgentDropdown - Agent selector dropdown
 * @description Allows switching between primary CLI agents (build, plan, custom).
 *              Uses DropdownMenu with standard item fields (icon, description)
 *              for consistent styling — no custom renderItem needed.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { useSettingsStore } from '../../store';
import { AgentsIcon, BotIcon, PlanIcon } from '../icons';
import { DropdownMenu, type DropdownMenuItem } from '../ui';

interface AgentData {
	id: string;
}

const FALLBACK_AGENT_ITEMS: Array<{
	id: string;
	description: string;
}> = [
	{ id: 'build', description: 'OpenCode default agent fallback' },
	{ id: 'plan', description: 'Read-only analysis and planning' },
];

/** Resolve icon for a given agent id. */
function getAgentIcon(agentId: string, size = 14) {
	switch (agentId) {
		case 'build':
			return <AgentsIcon size={size} />;
		case 'plan':
			return <PlanIcon size={size} />;
		default:
			return <BotIcon size={size} />;
	}
}

/** Resolve display label for a given agent id (supports hyphenated names like 'custom-agent'). */
function getAgentLabel(agentId: string | undefined): string {
	if (!agentId || agentId === 'build') return 'Build';
	// If the name already contains spaces (e.g. "Sisyphus - Ultraworker"), use as-is with title case on first char.
	if (agentId.includes(' ')) {
		return agentId.charAt(0).toUpperCase() + agentId.slice(1);
	}
	return agentId
		.split('-')
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

interface AgentDropdownProps {
	anchorElement?: HTMLElement | null;
	onSelect: (agent: string | undefined) => void;
	onClose: () => void;
}

/** Resolve the current agent icon for the toolbar button. */
export function AgentButtonIcon({
	agentId,
	size = 14,
	className,
}: {
	agentId: string | undefined;
	size?: number;
	className?: string;
}) {
	const id = agentId || 'build';
	return <span className={className}>{getAgentIcon(id, size)}</span>;
}

export { getAgentLabel };

export const AgentDropdown: React.FC<AgentDropdownProps> = ({
	anchorElement,
	onSelect,
	onClose,
}) => {
	const agentResources = useSettingsStore(state => state.resources.agent.items);

	const items = useMemo<DropdownMenuItem<AgentData>[]>(() => {
		const primaryResources = agentResources.filter(
			resource =>
				!resource.disabled &&
				!resource.hidden &&
				(resource.mode === 'primary' || resource.mode === undefined),
		);
		const resourceItems = primaryResources.map(resource => ({
			id: resource.name,
			description: resource.description,
		}));
		const agentItems = (resourceItems.length > 0 ? resourceItems : FALLBACK_AGENT_ITEMS).map(a => ({
			id: a.id,
			label: getAgentLabel(a.id),
			icon: getAgentIcon(a.id, 14),
			description: a.description,
			data: { id: a.id },
		}));

		return agentItems;
	}, [agentResources]);

	const handleSelect = useCallback(
		(agent: AgentData) => {
			onSelect(agent.id === 'build' ? undefined : agent.id);
		},
		[onSelect],
	);

	return (
		<DropdownMenu
			items={items}
			onSelect={handleSelect}
			onClose={onClose}
			keyHints={{}}
			position="top"
			minWidth={140}
			maxWidth={200}
			anchorElement={anchorElement}
		/>
	);
};
