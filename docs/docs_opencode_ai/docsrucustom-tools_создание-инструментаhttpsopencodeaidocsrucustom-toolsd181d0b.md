<!-- Source: https://opencode.ai/docs/ru/custom-tools -->

## [Создание инструмента](https://opencode.ai/docs/ru/custom-tools#%D1%81%D0%BE%D0%B7%D0%B4%D0%B0%D0%BD%D0%B8%D0%B5-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%B0)
Инструменты определяются как файлы **TypeScript** или **JavaScript**. Однако определение инструмента может вызывать сценарии, написанные на **любом языке** — TypeScript или JavaScript используются только для самого определения инструмента.
* * *

### [Расположение](https://opencode.ai/docs/ru/custom-tools#%D1%80%D0%B0%D1%81%D0%BF%D0%BE%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5)
Их можно определить:
  * Локально, поместив их в каталог `.opencode/tools/` вашего проекта.
  * Или глобально, поместив их в `~/.config/opencode/tools/`.


* * *

### [Структура](https://opencode.ai/docs/ru/custom-tools#%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%82%D1%83%D1%80%D0%B0)
Самый простой способ создания инструментов — использовать помощник `tool()`, который обеспечивает безопасность типов и проверку.
.opencode/tools/database.ts```


import { tool } from"@opencode-ai/plugin"




exportdefaulttool({




description: "Query the project database",



args: {



query: tool.schema.string().describe("SQL query to execute"),



},



asyncexecute(args) {



// Your database logic here



return`Executed query: ${args.query}`



},


})

```

**имя файла** становится **именем инструмента**. Вышеупомянутое создает инструмент `database`.
* * *
#### [Несколько инструментов в файле](https://opencode.ai/docs/ru/custom-tools#%D0%BD%D0%B5%D1%81%D0%BA%D0%BE%D0%BB%D1%8C%D0%BA%D0%BE-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%BE%D0%B2-%D0%B2-%D1%84%D0%B0%D0%B9%D0%BB%D0%B5)
Вы также можете экспортировать несколько инструментов из одного файла. Каждый экспорт становится **отдельным инструментом** с именем **`<filename>_<exportname>`**:
.opencode/tools/math.ts```


import { tool } from"@opencode-ai/plugin"




exportconstadd=tool({




description: "Add two numbers",



args: {



a: tool.schema.number().describe("First number"),




b: tool.schema.number().describe("Second number"),



},



asyncexecute(args) {




return args.a + args.b



},


})



exportconstmultiply=tool({




description: "Multiply two numbers",



args: {



a: tool.schema.number().describe("First number"),




b: tool.schema.number().describe("Second number"),



},



asyncexecute(args) {




return args.a * args.b



},


})

```

При этом создаются два инструмента: `math_add` и `math_multiply`.
* * *

### [Аргументы](https://opencode.ai/docs/ru/custom-tools#%D0%B0%D1%80%D0%B3%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B)
Вы можете использовать `tool.schema`, то есть просто [Zod](https://zod.dev), для определения типов аргументов.
```


args: {




query: tool.schema.string().describe("SQL query to execute")



}

```

Вы также можете импортировать [Zod](https://zod.dev) напрямую и вернуть простой объект:
```


import { z } from"zod"




exportdefault {




description: "Tool description",



args: {



param: z.string().describe("Parameter description"),



},



asyncexecute(args, context) {



// Tool implementation



return"result"



},


}

```

* * *

### [Контекст](https://opencode.ai/docs/ru/custom-tools#%D0%BA%D0%BE%D0%BD%D1%82%D0%B5%D0%BA%D1%81%D1%82)
Инструменты получают контекст текущего сеанса:
.opencode/tools/project.ts```


import { tool } from"@opencode-ai/plugin"




exportdefaulttool({




description: "Get project information",



args: {},



asyncexecute(args, context) {



// Access context information



const { agent, sessionID, messageID, directory, worktree } = context




return`Agent: ${agent}, Session: ${sessionID}, Message: ${messageID}, Directory: ${directory}, Worktree: ${worktree}`



},


})

```

Используйте `context.directory` для рабочего каталога сеанса. Используйте `context.worktree` для корня рабочего дерева git.
* * *

