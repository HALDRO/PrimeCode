/**
 * @file frontmatter.ts
 * @description Utilities for parsing and stringifying Markdown Frontmatter (YAML-like) using js-yaml.
 */

import * as yaml from 'js-yaml';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Parses a markdown string with YAML-like frontmatter.
 * Returns the frontmatter as a key-value object and the remaining body content.
 */
export function parseFrontmatter(content: string): {
	attributes: Record<string, unknown>;
	body: string;
} {
	const match = content.match(FRONTMATTER_REGEX);

	if (!match) {
		return {
			attributes: {},
			body: content.trim(),
		};
	}

	const [, frontmatterStr, body] = match;

	try {
		const loaded = yaml.load(frontmatterStr) as Record<string, unknown>;
		if (typeof loaded === 'object' && loaded !== null) {
			return {
				attributes: loaded,
				body: body.trim(),
			};
		}
	} catch (e) {
		console.warn('Failed to parse frontmatter YAML:', e);
	}

	return {
		attributes: {},
		body: body.trim(),
	};
}

/**
 * Creates a markdown string with YAML-like frontmatter.
 */
export function stringifyFrontmatter(attributes: Record<string, unknown>, body: string): string {
	const cleanAttributes: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined && value !== '') {
			cleanAttributes[key] = value;
		}
	}

	if (Object.keys(cleanAttributes).length === 0) {
		return body.trim();
	}

	// lineWidth: -1 prevents line folding for long strings
	const yamlStr = yaml.dump(cleanAttributes, { lineWidth: -1 }).trim();

	return `---\n${yamlStr}\n---\n\n${body.trim()}\n`;
}
