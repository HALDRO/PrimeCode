<!-- Source: https://opencode.ai/docs/server -->

## [API](https://opencode.ai/docs/server#api)
Сервер opencode предоставляет следующие API.
* * *

### [Глобальный](https://opencode.ai/docs/server#%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/global/health` | Get server health and version | `{ healthy: true, version: string }`  
`GET` | `/global/event` | Get global events (SSE stream) | Event stream  
* * *

### [Проект](https://opencode.ai/docs/server#%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/project` | List all projects | [`Project[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/project/current` | Get the current project | [`Project`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *

### [Путь и система контроля версий](https://opencode.ai/docs/server#%D0%BF%D1%83%D1%82%D1%8C-%D0%B8-%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC%D0%B0-%D0%BA%D0%BE%D0%BD%D1%82%D1%80%D0%BE%D0%BB%D1%8F-%D0%B2%D0%B5%D1%80%D1%81%D0%B8%D0%B9)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/path` | Get the current path | [`Path`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/vcs` | Get VCS info for the current project | [`VcsInfo`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *

### [Экземпляр](https://opencode.ai/docs/server#%D1%8D%D0%BA%D0%B7%D0%B5%D0%BC%D0%BF%D0%BB%D1%8F%D1%80)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`POST` | `/instance/dispose` | Dispose the current instance | `boolean`  
* * *

### [Конфигурация](https://opencode.ai/docs/server#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/config` | Get config info | [`Config`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`PATCH` | `/config` | Update config | [`Config`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/config/providers` | List providers and default models |  `{ providers: `[Provider[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, default: { [key: string]: string } }`  
* * *

### [Поставщик](https://opencode.ai/docs/server#%D0%BF%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/provider` | List all providers |  `{ all: `[Provider[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, default: {...}, connected: string[] }`  
`GET` | `/provider/auth` | Get provider authentication methods |  `{ [providerID: string]: `[ProviderAuthMethod[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)` }`  
`POST` | `/provider/{id}/oauth/authorize` | Authorize a provider using OAuth | [`ProviderAuthAuthorization`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`POST` | `/provider/{id}/oauth/callback` | Handle OAuth callback for a provider | `boolean`  
* * *

### [Сессии](https://opencode.ai/docs/server#%D1%81%D0%B5%D1%81%D1%81%D0%B8%D0%B8)
Метод | Путь | Описание | Примечания  
---|---|---|---  
`GET` | `/session` | List all sessions | Returns [`Session[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`POST` | `/session` | Create a new session | body: `{ parentID?, title? }`, returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/session/status` | Get session status for all sessions | Returns `{ [sessionID: string]: `[SessionStatus](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)` }`  
`GET` | `/session/:id` | Get session details | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`DELETE` | `/session/:id` | Delete a session and all its data | Returns `boolean`  
`PATCH` | `/session/:id` | Update session properties | body: `{ title? }`, returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/session/:id/children` | Get a session’s child sessions | Returns [`Session[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/session/:id/todo` | Get the todo list for a session | Returns [`Todo[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`POST` | `/session/:id/init` | Analyze app and create `AGENTS.md` | body: `{ messageID, providerID, modelID }`, returns `boolean`  
`POST` | `/session/:id/fork` | Fork an existing session at a message | body: `{ messageID? }`, returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`POST` | `/session/:id/abort` | Abort a running session | Returns `boolean`  
`POST` | `/session/:id/share` | Share a session | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`DELETE` | `/session/:id/share` | Unshare a session | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/session/:id/diff` | Get the diff for this session | query: `messageID?`, returns [`FileDiff[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`POST` | `/session/:id/summarize` | Summarize the session | body: `{ providerID, modelID }`, returns `boolean`  
`POST` | `/session/:id/revert` | Revert a message | body: `{ messageID, partID? }`, returns `boolean`  
`POST` | `/session/:id/unrevert` | Restore all reverted messages | Returns `boolean`  
`POST` | `/session/:id/permissions/:permissionID` | Respond to a permission request | body: `{ response, remember? }`, returns `boolean`  
* * *

### [Сообщения](https://opencode.ai/docs/server#%D1%81%D0%BE%D0%BE%D0%B1%D1%89%D0%B5%D0%BD%D0%B8%D1%8F)
Метод | Путь | Описание | Примечания  
---|---|---|---  
`GET` | `/session/:id/message` | List messages in a session | query: `limit?`, returns `{ info: `[Message](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[Part[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}[]`  
`POST` | `/session/:id/message` | Send a message and wait for response | body: `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }`, returns `{ info: `[Message](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[Part[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}`  
`GET` | `/session/:id/message/:messageID` | Get message details | Returns `{ info: `[Message](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[Part[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}`  
`POST` | `/session/:id/prompt_async` | Send a message asynchronously (no wait) | body: same as `/session/:id/message`, returns `204 No Content`  
`POST` | `/session/:id/command` | Execute a slash command | body: `{ messageID?, agent?, model?, command, arguments }`, returns `{ info: `[Message](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[Part[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}`  
`POST` | `/session/:id/shell` | Run a shell command | body: `{ agent, model?, command }`, returns `{ info: `[Message](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[Part[]](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}`  
* * *

### [Команды](https://opencode.ai/docs/server#%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D1%8B)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/command` | List all commands | [`Command[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *

### [Файлы](https://opencode.ai/docs/server#%D1%84%D0%B0%D0%B9%D0%BB%D1%8B)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/find?pattern=<pat>` | Search for text in files | Array of match objects with `path`, `lines`, `line_number`, `absolute_offset`, `submatches`  
`GET` | `/find/file?query=<q>` | Find files and directories by name |  `string[]` (paths)  
`GET` | `/find/symbol?query=<q>` | Find workspace symbols | [`Symbol[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/file?path=<path>` | List files and directories | [`FileNode[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/file/content?path=<p>` | Read a file | [`FileContent`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/file/status` | Get status for tracked files | [`File[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
#### [`/find/file` параметры запроса](https://opencode.ai/docs/server#findfile-%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B-%D0%B7%D0%B0%D0%BF%D1%80%D0%BE%D1%81%D0%B0)
  * `query` (обязательно) — строка поиска (нечеткое совпадение)
  * `type` (необязательно) — ограничить результаты `"file"` или `"directory"`.
  * `directory` (необязательно) — переопределить корень проекта для поиска.
  * `limit` (необязательно) — максимальное количество результатов (1–200)
  * `dirs` (необязательно) — устаревший флаг (`"false"` возвращает только файлы)


* * *

### [Инструменты (Экспериментальные)](https://opencode.ai/docs/server#%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B-%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D1%80%D0%B8%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/experimental/tool/ids` | List all tool IDs | [`ToolIDs`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/experimental/tool?provider=<p>&model=<m>` | List tools with JSON schemas for a model | [`ToolList`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *

### [LSP, форматтеры и MCP](https://opencode.ai/docs/server#lsp-%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D1%82%D0%B5%D1%80%D1%8B-%D0%B8-mcp)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/lsp` | Get LSP server status | [`LSPStatus[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/formatter` | Get formatter status | [`FormatterStatus[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`GET` | `/mcp` | Get MCP server status |  `{ [name: string]: `[MCPStatus](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)` }`  
`POST` | `/mcp` | Add MCP server dynamically | body: `{ name, config }`, returns MCP status object  
* * *

### [Агенты](https://opencode.ai/docs/server#%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/agent` | List all available agents | [`Agent[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *

### [Ведение журнала](https://opencode.ai/docs/server#%D0%B2%D0%B5%D0%B4%D0%B5%D0%BD%D0%B8%D0%B5-%D0%B6%D1%83%D1%80%D0%BD%D0%B0%D0%BB%D0%B0)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`POST` | `/log` | Write log entry. Body: `{ service, level, message, extra? }` | `boolean`  
* * *

### [TUI](https://opencode.ai/docs/server#tui)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`POST` | `/tui/append-prompt` | Append text to the prompt | `boolean`  
`POST` | `/tui/open-help` | Open the help dialog | `boolean`  
`POST` | `/tui/open-sessions` | Open the session selector | `boolean`  
`POST` | `/tui/open-themes` | Open the theme selector | `boolean`  
`POST` | `/tui/open-models` | Open the model selector | `boolean`  
`POST` | `/tui/submit-prompt` | Submit the current prompt | `boolean`  
`POST` | `/tui/clear-prompt` | Clear the prompt | `boolean`  
`POST` | `/tui/execute-command` | Execute a command (`{ command }`) | `boolean`  
`POST` | `/tui/show-toast` | Show toast (`{ title?, message, variant }`) | `boolean`  
`GET` | `/tui/control/next` | Wait for the next control request | Control request object  
`POST` | `/tui/control/response` | Respond to a control request (`{ body }`) | `boolean`  
* * *

### [Авторизация](https://opencode.ai/docs/server#%D0%B0%D0%B2%D1%82%D0%BE%D1%80%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D1%8F)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`PUT` | `/auth/:id` | Set authentication credentials. Body must match provider schema | `boolean`  
* * *

### [События](https://opencode.ai/docs/server#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/event` | Server-sent events stream. First event is `server.connected`, then bus events | Server-sent events stream  
* * *

### [Документы](https://opencode.ai/docs/server#%D0%B4%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B)
Метод | Путь | Описание | Ответ  
---|---|---|---  
`GET` | `/doc` | OpenAPI 3.1 specification | HTML page with OpenAPI spec  
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/server.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

