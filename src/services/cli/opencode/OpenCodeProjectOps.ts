/**
 * @file OpenCode Project Operations
 * @description Handles project management and message part operations.
 * Extends BaseOpenCodeOps for unified error handling and reduced boilerplate.
 * Uses Context Accessor pattern for safe state access.
 * Implements SDK v2 project.* and part.* endpoints.
 */

import { BaseOpenCodeOps } from './BaseOpenCodeOps.js';

/** Project information from SDK (sandboxes is optional in some responses) */
export interface ProjectInfo {
	id: string;
	worktree: string;
	name?: string;
	vcs?: 'git';
	icon?: {
		url?: string;
		color?: string;
	};
	time: {
		created: number;
		updated: number;
		initialized?: number;
	};
	sandboxes?: string[];
}

/** Project update input */
export interface ProjectUpdateInput {
	name?: string;
	icon?: {
		url?: string;
		color?: string;
	};
}

/** Message part types from SDK v2 */
export type PartType =
	| 'text'
	| 'reasoning'
	| 'file'
	| 'tool'
	| 'step-start'
	| 'step-finish'
	| 'snapshot'
	| 'patch'
	| 'agent'
	| 'retry'
	| 'compaction'
	| 'subtask';

/** Base part structure */
export interface BasePart {
	id: string;
	sessionID: string;
	messageID: string;
	type: PartType;
}

/** Text part */
export interface TextPart extends BasePart {
	type: 'text';
	text: string;
	synthetic?: boolean;
	ignored?: boolean;
	time?: { start: number; end?: number };
	metadata?: Record<string, unknown>;
}

/** Tool part state */
export interface ToolState {
	status: 'pending' | 'running' | 'completed' | 'error';
	input: Record<string, unknown>;
	output?: string;
	error?: string;
	title?: string;
	metadata?: Record<string, unknown>;
	time?: { start: number; end?: number; compacted?: number };
}

/** Tool part */
export interface ToolPart extends BasePart {
	type: 'tool';
	callID: string;
	tool: string;
	state: ToolState;
	metadata?: Record<string, unknown>;
}

/** Generic part union (simplified) */
export type Part = TextPart | ToolPart | BasePart;

/** SDK Project type (internal) */
interface SdkProject {
	id: string;
	worktree: string;
	name?: string;
	vcs?: 'git';
	icon?: { url?: string; color?: string };
	time: { created: number; updated: number; initialized?: number };
	sandboxes?: string[];
}

export class OpenCodeProjectOps extends BaseOpenCodeOps {
	// =========================================================================
	// Project Management
	// =========================================================================

	/**
	 * List all projects that have been opened with OpenCode
	 */
	public async listProjects(): Promise<ProjectInfo[] | null> {
		return this.safeExecute<SdkProject[], ProjectInfo[]>(
			'List projects',
			client => client.project.list({ directory: this._workspaceDir }),
			data =>
				(data || []).map(p => ({
					id: p.id,
					worktree: p.worktree,
					name: p.name,
					vcs: p.vcs,
					icon: p.icon,
					time: p.time,
					sandboxes: p.sandboxes,
				})),
		);
	}

	/**
	 * Get the currently active project
	 */
	public async getCurrentProject(): Promise<ProjectInfo | null> {
		return this.safeExecute<SdkProject, ProjectInfo>(
			'Get current project',
			client => client.project.current({ directory: this._workspaceDir }),
			p => ({
				id: p.id,
				worktree: p.worktree,
				name: p.name,
				vcs: p.vcs,
				icon: p.icon,
				time: p.time,
				sandboxes: p.sandboxes,
			}),
		);
	}

	/**
	 * Update project properties (name, icon)
	 */
	public async updateProject(
		projectId: string,
		updates: ProjectUpdateInput,
	): Promise<{ success: boolean; project?: ProjectInfo; error?: string }> {
		const result = await this.safeExecuteWithLog<SdkProject, { project: ProjectInfo }>(
			`Updating project ${projectId}`,
			client =>
				client.project.update({
					projectID: projectId,
					directory: this._workspaceDir,
					name: updates.name,
					icon: updates.icon,
				}),
			p => ({
				project: {
					id: p.id,
					worktree: p.worktree,
					name: p.name,
					vcs: p.vcs,
					icon: p.icon,
					time: p.time,
					sandboxes: p.sandboxes,
				},
			}),
		);

		return {
			success: result.success,
			project: result.data?.project,
			error: result.error,
		};
	}

	// =========================================================================
	// Message Part Operations
	// =========================================================================

	/**
	 * Delete a part from a message
	 */
	public async deletePart(
		sessionId: string,
		messageId: string,
		partId: string,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Deleting part ${partId} from message ${messageId}`,
			client =>
				client.part.delete({
					sessionID: sessionId,
					messageID: messageId,
					partID: partId,
					directory: this._workspaceDir,
				}),
		);

		return { success: result.success, error: result.error };
	}

	/**
	 * Update a part in a message
	 */
	public async updatePart(
		sessionId: string,
		messageId: string,
		partId: string,
		partData: Record<string, unknown>,
	): Promise<{ success: boolean; part?: Record<string, unknown>; error?: string }> {
		const result = await this.safeExecuteWithLog<
			Record<string, unknown>,
			{ part: Record<string, unknown> }
		>(
			`Updating part ${partId} in message ${messageId}`,
			client =>
				client.part.update({
					sessionID: sessionId,
					messageID: messageId,
					partID: partId,
					directory: this._workspaceDir,
					// SDK expects Part type, but we accept generic Record for flexibility
					// biome-ignore lint/suspicious/noExplicitAny: SDK Part type is complex union, using any for flexibility
					part: partData as any,
				}),
			data => ({ part: data }),
		);

		return {
			success: result.success,
			part: result.data?.part,
			error: result.error,
		};
	}
}
