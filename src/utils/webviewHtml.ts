/**
 * @file HTML template for the webview
 * @description Generates the HTML shell that loads the React application.
 *              Uses proper CSP directives for VS Code webview security.
 *              Process polyfill is injected inline to ensure availability before any scripts run.
 *              The body class "vscode-dark" triggers VS Code to inject theme CSS variables.
 */

export const getHtml = (
	scriptUri: string,
	styleUri: string,
	isTelemetryEnabled: boolean,
	workspaceRoot = '',
) => `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-webview: vscode-resource: file:; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-webview: vscode-resource: file:; img-src data: https: blob: vscode-webview: vscode-resource: file:; font-src data: https: vscode-webview: vscode-resource: file:; connect-src https: wss: localhost:* http://localhost:*;">
	<title>PrimeCode</title>
	<link href="${styleUri}" rel="stylesheet">
	<!-- Preload codicon font to prevent flickering/loading issues -->
	<link rel="preload" as="font" crossorigin="anonymous" href="https://vscode-webview-resource/codicon.ttf">
</head>
<body class="vscode-dark" data-vscode-theme-kind="vscode-dark" data-workspace-root="${workspaceRoot}">
	<div id="root"></div>
	<script>
		// Process polyfill for browser environment (required by React and other libs)
		if (typeof globalThis.process === "undefined") {
			globalThis.process = { env: { NODE_ENV: "production" }, platform: "browser", version: "", emit: function() {} };
		}
		// Avoid including any mock/dev-only globals in production webview.
		window.isTelemetryEnabled = ${isTelemetryEnabled};
		window.workspaceRoot = "${workspaceRoot}";
	</script>
	<script src="${scriptUri}"></script>
	${isTelemetryEnabled ? '<script defer src="https://cloud.umami.is/script.js" data-website-id="d050ac9b-2b6d-4c67-b4c6-766432f95644"></script>' : ''}
</body>
</html>`;
