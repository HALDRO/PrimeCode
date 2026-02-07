/**
 * @file HTML template for the webview
 * @description Generates the HTML shell that loads the React application inside VS Code webview.
 *              Uses VS Code's cspSource for proper Content-Security-Policy integration, including
 *              worker-src directive required by VS Code's internal ServiceWorker resource loader.
 *              Process polyfill is injected inline to ensure availability before any scripts run.
 *              The body class "vscode-dark" triggers VS Code to inject theme CSS variables.
 */

export const getHtml = (
	scriptUri: string,
	styleUri: string,
	cspSource: string,
	isTelemetryEnabled: boolean,
	workspaceRoot = '',
) => `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' 'unsafe-eval' ${cspSource}; img-src data: https: blob: ${cspSource}; font-src data: https: ${cspSource}; worker-src 'self' blob: ${cspSource}; connect-src https: wss: localhost:* http://localhost:*;">
	<title>PrimeCode</title>
	<link href="${styleUri}" rel="stylesheet">
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
