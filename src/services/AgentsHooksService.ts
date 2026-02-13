/**
 * @file AgentsHooksService
 * @description Manages hook definitions stored under `.agents/hooks/`.
 *              Extends BaseAgentResourceService for CRUD with vscode.workspace.fs.
 *              Uses hookify naming convention (`hookify.*.local.md`).
 */

import type { ParsedHook } from '../common';
import { PATHS } from '../common/constants';
import { BaseAgentResourceService } from './BaseAgentResourceService';

export class AgentsHooksService extends BaseAgentResourceService<ParsedHook> {
	protected readonly resourceDir = PATHS.AGENTS_HOOKS_DIR;

	protected getFileName(name: string): string {
		return `hookify.${name}.local.md`;
	}

	protected getNameFromFileName(fileName: string): string {
		return fileName
			.replace(/^hookify\./, '')
			.replace(/\.local\.md$/, '')
			.replace(/\.md$/, '');
	}

	protected parseResource(
		attributes: Record<string, string | boolean>,
		body: string,
		fileName: string,
	): ParsedHook {
		const nameFromFile = this.getNameFromFileName(fileName);
		return {
			name: String(attributes.name || nameFromFile),
			enabled: attributes.enabled !== false,
			event: String(attributes.event || 'all'),
			pattern: attributes.pattern ? String(attributes.pattern) : undefined,
			action: attributes.action ? String(attributes.action) : undefined,
			content: body,
			path: this.buildRelativePath(fileName),
		};
	}

	protected stringifyResource(item: Partial<ParsedHook> & { name: string }): {
		attributes: Record<string, string | boolean | undefined>;
		body: string;
	} {
		return {
			attributes: {
				name: item.name,
				enabled: item.enabled,
				event: item.event,
				pattern: item.pattern,
				action: item.action,
			},
			body: item.content ?? '',
		};
	}
}

export const agentsHooksService = new AgentsHooksService();
