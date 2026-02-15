<!-- Source: https://opencode.ai/docs/sdk -->

## [API](https://opencode.ai/docs/sdk#api)
SDK предоставляет все серверные API через типобезопасный клиент.
* * *

### [Глобальный](https://opencode.ai/docs/sdk#%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9)
Метод | Описание | Ответ  
---|---|---  
`global.health()` | Check server health and version | `{ healthy: true, version: string }`  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B)
```


consthealth=await client.global.health()




console.log(health.data.version)


```

* * *

### [Приложение](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5)
Метод | Описание | Ответ  
---|---|---  
`app.log()` | Write a log entry | `boolean`  
`app.agents()` | List all available agents | [`Agent[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-1)
```

// Write a log entry



await client.app.log({



body: {



service: "my-app",




level: "info",




message: "Operation completed",



},


})


// List available agents



constagents=await client.app.agents()


```

* * *

### [Проект](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82)
Метод | Описание | Ответ  
---|---|---  
`project.list()` | List all projects | [`Project[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`project.current()` | Get current project | [`Project`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-2)
```

// List all projects



constprojects=await client.project.list()



// Get current project



constcurrentProject=await client.project.current()


```

* * *

### [Путь](https://opencode.ai/docs/sdk#%D0%BF%D1%83%D1%82%D1%8C)
Метод | Описание | Ответ  
---|---|---  
`path.get()` | Get current path | [`Path`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-3)
```

// Get current path information



constpathInfo=await client.path.get()


```

* * *

### [Конфигурация](https://opencode.ai/docs/sdk#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F-1)
Метод | Описание | Ответ  
---|---|---  
`config.get()` | Get config info | [`Config`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`config.providers()` | List providers and default models |  `{ providers: `[`Provider[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, default: { [key: string]: string } }`  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-4)
```


constconfig=await client.config.get()




const { providers, default: defaults } =await client.config.providers()


```

* * *

### [Сессии](https://opencode.ai/docs/sdk#%D1%81%D0%B5%D1%81%D1%81%D0%B8%D0%B8)
Метод | Описание | Примечания  
---|---|---  
`session.list()` | List sessions | Returns [`Session[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.get({ path })` | Get session | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.children({ path })` | List child sessions | Returns [`Session[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.create({ body })` | Create session | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.delete({ path })` | Delete session | Returns `boolean`  
`session.update({ path, body })` | Update session properties | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.init({ path, body })` | Analyze app and create `AGENTS.md` | Returns `boolean`  
`session.abort({ path })` | Abort a running session | Returns `boolean`  
`session.share({ path })` | Share session | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.unshare({ path })` | Unshare session | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.summarize({ path, body })` | Summarize session | Returns `boolean`  
`session.messages({ path })` | List messages in a session | Returns `{ info: `[`Message`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[`Part[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}[]`  
`session.message({ path })` | Get message details | Returns `{ info: `[`Message`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[`Part[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}`  
`session.prompt({ path, body })` | Send prompt message |  `body.noReply: true` returns UserMessage (context only). Default returns [`AssistantMessage`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts) with AI response  
`session.command({ path, body })` | Send command to session | Returns `{ info: `[`AssistantMessage`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`, parts: `[`Part[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)`}`  
`session.shell({ path, body })` | Run a shell command | Returns [`AssistantMessage`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.revert({ path, body })` | Revert a message | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`session.unrevert({ path })` | Restore reverted messages | Returns [`Session`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`postSessionByIdPermissionsByPermissionId({ path, body })` | Respond to a permission request | Returns `boolean`  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-5)
```

// Create and manage sessions



constsession=await client.session.create({




body: { title: "My session" },



})



constsessions=await client.session.list()



// Send a prompt message



constresult=await client.session.prompt({



path: { id: session.id },


body: {



model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },




parts: [{ type: "text", text: "Hello!" }],



},


})


// Inject context without triggering AI response (useful for plugins)



await client.session.prompt({



path: { id: session.id },


body: {



noReply: true,




parts: [{ type: "text", text: "You are a helpful assistant." }],



},


})

```

* * *

### [Файлы](https://opencode.ai/docs/sdk#%D1%84%D0%B0%D0%B9%D0%BB%D1%8B)
Метод | Описание | Ответ  
---|---|---  
`find.text({ query })` | Search for text in files | Array of match objects with `path`, `lines`, `line_number`, `absolute_offset`, `submatches`  
`find.files({ query })` | Find files and directories by name |  `string[]` (paths)  
`find.symbols({ query })` | Find workspace symbols | [`Symbol[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`file.read({ query })` | Read a file | `{ type: "raw" | "patch", content: string }`  
`file.status({ query? })` | Get status for tracked files | [`File[]`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)  
`find.files` поддерживает несколько дополнительных полей запроса:
  * `type`: `"file"` или `"directory"`
  * `directory`: переопределить корень проекта для поиска.
  * `limit`: максимальное количество результатов (1–200)


* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-6)
```

// Search and read files



consttextResults=await client.find.text({




query: { pattern: "function.*opencode" },



})



constfiles=await client.find.files({




query: { query: "*.ts", type: "file" },



})



constdirectories=await client.find.files({




query: { query: "packages", type: "directory", limit: 20 },



})



constcontent=await client.file.read({




query: { path: "src/index.ts" },



})

```

* * *

### [TUI](https://opencode.ai/docs/sdk#tui)
Метод | Описание | Ответ  
---|---|---  
`tui.appendPrompt({ body })` | Append text to the prompt | `boolean`  
`tui.openHelp()` | Open the help dialog | `boolean`  
`tui.openSessions()` | Open the session selector | `boolean`  
`tui.openThemes()` | Open the theme selector | `boolean`  
`tui.openModels()` | Open the model selector | `boolean`  
`tui.submitPrompt()` | Submit the current prompt | `boolean`  
`tui.clearPrompt()` | Clear the prompt | `boolean`  
`tui.executeCommand({ body })` | Execute a command | `boolean`  
`tui.showToast({ body })` | Show toast notification | `boolean`  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-7)
```

// Control TUI interface



await client.tui.appendPrompt({




body: { text: "Add this to prompt" },



})



await client.tui.showToast({




body: { message: "Task completed", variant: "success" },



})

```

* * *

### [Аутентификация](https://opencode.ai/docs/sdk#%D0%B0%D1%83%D1%82%D0%B5%D0%BD%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
Метод | Описание | Ответ  
---|---|---  
`auth.set({ ... })` | Set authentication credentials | `boolean`  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-8)
```


await client.auth.set({




path: { id: "anthropic" },




body: { type: "api", key: "your-api-key" },



})

```

* * *

### [События](https://opencode.ai/docs/sdk#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F)
Метод | Описание | Ответ  
---|---|---  
`event.subscribe()` | Server-sent events stream | Server-sent events stream  
* * *
#### [Примеры](https://opencode.ai/docs/sdk#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-9)
```

// Listen to real-time events



constevents=await client.event.subscribe()




forawait (consteventof events.stream) {




console.log("Event:", event.type, event.properties)



}

```

[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/sdk.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

