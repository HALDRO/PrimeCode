/**
 * @file opencodeSchemas
 * @description Centralized TypeBox runtime schemas + lightweight validation helpers for the
 *              OpenCode SDK integration. Keeping schemas and boundary validation in one module
 *              reduces boilerplate in parsers/handlers and makes cross-file contract updates explicit.
 */

import type { TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { logger } from '../../../utils/logger';

export type ValidateOrLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ValidateOrLogContext = {
	component: string;
	label: string;
	sessionId?: string;
	level?: ValidateOrLogLevel;
};

/**
 * Validates `value` against a TypeBox `schema` and logs a compact message on failure.
 * Returns `true` when value matches; otherwise logs and returns `false`.
 */
export function validateOrLog(schema: TSchema, value: unknown, ctx: ValidateOrLogContext): boolean {
	if (Value.Check(schema, value)) {
		return true;
	}

	const errors = [...Value.Errors(schema, value)];
	const level: ValidateOrLogLevel = ctx.level ?? 'warn';
	const log =
		level === 'error'
			? logger.error.bind(logger)
			: level === 'warn'
				? logger.warn.bind(logger)
				: level === 'info'
					? logger.info.bind(logger)
					: logger.debug.bind(logger);

	const maxDetails = 3;
	const details = errors
		.slice(0, maxDetails)
		.map(e => `${e.path}: ${e.message}`)
		.join('; ');

	log(
		`[${ctx.component}] Invalid ${ctx.label} rejected` +
			(ctx.sessionId ? `: sessionId=${ctx.sessionId}` : '') +
			`, errors=${errors.length}` +
			(details.length > 0 ? `, details=${details}` : ''),
	);

	return false;
}

/** Minimal runtime schema for OpenCode SDK events (outer envelope only). */
export const OpenCodeEventSchema = Type.Object({
	type: Type.String(),
	properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** Runtime schema for `message.updated` event properties. */
export const MessageUpdatedSchema = Type.Object({
	info: Type.Object({
		id: Type.String(),
		role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
		parts: Type.Optional(Type.Array(Type.Any())),
		tokens: Type.Optional(
			Type.Object({
				input: Type.Optional(Type.Number()),
				output: Type.Optional(Type.Number()),
				reasoning: Type.Optional(Type.Number()),
				cache: Type.Optional(
					Type.Object({
						read: Type.Optional(Type.Number()),
						write: Type.Optional(Type.Number()),
					}),
				),
			}),
		),
		time: Type.Optional(
			Type.Object({
				created: Type.Optional(Type.Number()),
				completed: Type.Optional(Type.Number()),
			}),
		),
	}),
});

/** Runtime schema for `session.error` event properties. */
export const SessionErrorSchema = Type.Object({
	error: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				name: Type.Optional(Type.String()),
				message: Type.Optional(Type.String()),
				data: Type.Optional(
					Type.Object({
						message: Type.Optional(Type.String()),
						statusCode: Type.Optional(Type.Number()),
					}),
				),
			}),
		]),
	),
	message: Type.Optional(Type.String()),
});

/**
 * Runtime schema for `message.part.updated` event properties.
 * This is a hot path: validating here prevents downstream crashes.
 */
export const MessagePartUpdatedSchema = Type.Object({
	part: Type.Object({
		id: Type.String(),
		type: Type.String(),
		messageID: Type.String(),
		text: Type.Optional(Type.String()),
		tool: Type.Optional(Type.String()),
		state: Type.Optional(Type.Any()),
		callID: Type.Optional(Type.String()),
		cost: Type.Optional(Type.Number()),
		tokens: Type.Optional(
			Type.Object({
				input: Type.Number(),
				output: Type.Number(),
				reasoning: Type.Number(),
				cache: Type.Object({ read: Type.Number(), write: Type.Number() }),
			}),
		),
		// Subtask fields
		prompt: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		agent: Type.Optional(Type.String()),
		command: Type.Optional(Type.String()),
	}),
	delta: Type.Optional(Type.String()),
});

/** Runtime schema for `permission.asked` event properties. */
export const PermissionAskedSchema = Type.Object({
	id: Type.String(),
	sessionID: Type.Optional(Type.String()),
	permission: Type.String(),
	patterns: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	tool: Type.Optional(
		Type.Object({
			messageID: Type.String(),
			callID: Type.Optional(Type.String()),
		}),
	),
});

/** Runtime schema for `file.edited` event properties. */
export const FileEditedSchema = Type.Object({
	file: Type.String(),
});

/** Runtime schema for `command.executed` event properties. */
export const CommandExecutedSchema = Type.Object({
	name: Type.String(),
	arguments: Type.Optional(Type.String()),
	sessionID: Type.Optional(Type.String()),
});

/** Runtime schema for `session.created` event properties. */
export const SessionCreatedSchema = Type.Object({
	info: Type.Object({
		id: Type.String(),
		title: Type.Optional(Type.String()),
		parentID: Type.Optional(Type.String()),
	}),
});

/** Runtime schema for `file.watcher.updated` event properties. */
export const FileWatcherUpdatedSchema = Type.Object({
	file: Type.String(),
	event: Type.Union([Type.Literal('add'), Type.Literal('change'), Type.Literal('unlink')]),
});

/** Runtime schema for `lsp.client.diagnostics` event properties. */
export const LspClientDiagnosticsSchema = Type.Object({
	serverID: Type.String(),
	path: Type.String(),
});

/** Runtime schema for `session.diff` event properties. */
export const SessionDiffSchema = Type.Object({
	sessionID: Type.String(),
	diff: Type.Array(
		Type.Object({
			file: Type.String(),
			before: Type.String(),
			after: Type.String(),
			additions: Type.Number(),
			deletions: Type.Number(),
		}),
	),
});
