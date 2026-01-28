import type { Plugin } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";

export const AgentsContextPlugin: Plugin = async ({ directory }) => {
	// Track which AGENTS.md files have been injected in this session
	const injectedAgentsFiles = new Set<string>();

	// Track file reads in progress (callID -> filePath)
	const fileReads = new Map<string, string>();

	// Track current session to reset state on session change
	let currentSessionID: string | null = null;

	// Shared function to find and format AGENTS.md files for a given file path
	const findAgentsContext = (filePath: string) => {
		const workspaceRoot = path.resolve(directory);

		// Normalize file path - handle workspace-relative paths
		let normalizedPath = path.resolve(filePath);
		if (!normalizedPath.startsWith(workspaceRoot)) {
			// Try joining with workspace root
			const candidate = path.join(workspaceRoot, filePath.replace(/^\/+/, ""));
			if (fs.existsSync(candidate)) {
				normalizedPath = candidate;
			}
		}

		const fileDir = path.dirname(normalizedPath);
		const agentsFiles: Array<{ path: string; dir: string; content: string }> =
			[];

		let currentDir = fileDir;

		// Walk up the directory tree
		while (true) {
			const agentsPath = path.join(currentDir, "AGENTS.md");

			// Only include if we haven't injected it before AND it's not the workspace root
			if (
				fs.existsSync(agentsPath) &&
				!injectedAgentsFiles.has(agentsPath) &&
				currentDir !== workspaceRoot
			) {
				const content = fs.readFileSync(agentsPath, "utf-8");
				agentsFiles.push({
					path: agentsPath,
					dir: currentDir,
					content,
				});
				injectedAgentsFiles.add(agentsPath);
			}

			// Stop if we've reached the workspace root
			if (currentDir === workspaceRoot) break;

			// Stop if we can't go up anymore
			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) break;

			// Check if parent is still within workspace using path.relative
			const rel = path.relative(workspaceRoot, parentDir);
			if (rel.startsWith("..") || path.isAbsolute(rel)) break;

			currentDir = parentDir;
		}

		// Format as system messages
		if (agentsFiles.length > 0) {
			return agentsFiles
				.map((file) => {
					const relativePath = path.relative(workspaceRoot, file.dir);
					const displayPath = relativePath ? relativePath : "(workspace root)";

					return (
						`<system_message>\n` +
						`You've read a file in ${displayPath}. ` +
						`This directory contains an AGENTS.md file with additional context:\n\n` +
						`${file.content}\n` +
						`</system_message>`
					);
				})
				.join("\n\n");
		}

		return null;
	};

	return {
		"tool.execute.before": async (input, output) => {
			// Reset state when session changes
			if (currentSessionID !== input.sessionID) {
				currentSessionID = input.sessionID;
				injectedAgentsFiles.clear();
				fileReads.clear();
			}

			if (input.tool === "read") {
				fileReads.set(input.callID, output.args.filePath);
			}
		},

		"tool.execute.after": async (input, output) => {
			if (input.tool === "read") {
				const filePath = fileReads.get(input.callID);
				fileReads.delete(input.callID);

				if (!filePath) return;

				const contextMessage = findAgentsContext(filePath);
				if (contextMessage) {
					output.output = `${output.output ?? ""}\n\n${contextMessage}`;
				}
			}
		},
	};
};
