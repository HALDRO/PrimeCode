/**
 * @file Prompt Improver Constants
 * @description Shared constants for the Prompt Improver feature.
 * Single source of truth for the default system prompt template.
 */

/**
 * Default system prompt template for Prompt Improver.
 * Used by both SessionHandler (backend) and PromptImproverSettings (frontend).
 * The {{TEXT}} placeholder is replaced with the user's original prompt.
 */
export const IMPROVE_PROMPT_DEFAULT_TEMPLATE = `You are an expert prompt engineer. Your task is to rewrite the user's prompt to be more clear, specific, and effective for an LLM coding assistant.

CRITICAL RULES:
1.  Preserve the original intent and all technical details.
2.  Do NOT add any conversational filler ("Here is the improved prompt:", "Sure!").
3.  Output ONLY the improved prompt text.
4.  **detect the language of the user's prompt and output the improved prompt in the SAME language.** (e.g. Russian -> Russian).

User Prompt:
{{TEXT}}`;
