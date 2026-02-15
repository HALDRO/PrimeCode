<!-- Source: https://opencode.ai/docs/plugins -->

## [Примеры](https://opencode.ai/docs/plugins#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B)
Вот несколько примеров плагинов, которые вы можете использовать для расширения opencode.
* * *

### [Отправлять уведомления](https://opencode.ai/docs/plugins#%D0%BE%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%82%D1%8C-%D1%83%D0%B2%D0%B5%D0%B4%D0%BE%D0%BC%D0%BB%D0%B5%D0%BD%D0%B8%D1%8F)
Отправляйте уведомления при возникновении определенных событий:
.opencode/plugins/notification.js```


exportconstNotificationPlugin=async ({ project, client, $, directory, worktree }) => {




return {




event: async ({ event }) => {



// Send notification on session completion



if (event.type ==="session.idle") {




await$`osascript -e 'display notification "Session completed!" with title "opencode"'`



}


},


}


}

```

Мы используем `osascript` для запуска AppleScript на macOS. Здесь мы используем его для отправки уведомлений.
Если вы используете настольное приложение opencode, оно может автоматически отправлять системные уведомления, когда ответ готов или когда возникает ошибка сеанса.
* * *

### [Защита .env](https://opencode.ai/docs/plugins#%D0%B7%D0%B0%D1%89%D0%B8%D1%82%D0%B0-env)
Запретите открытому коду читать файлы `.env`:
.opencode/plugins/env-protection.js```


exportconstEnvProtection=async ({ project, client, $, directory, worktree }) => {




return {




"tool.execute.before": async (input, output) => {




if (input.tool ==="read"&& output.args.filePath.includes(".env")) {




thrownewError("Do not read .env files")



}


},


}


}

```

* * *

### [Внедрение переменных среды](https://opencode.ai/docs/plugins#%D0%B2%D0%BD%D0%B5%D0%B4%D1%80%D0%B5%D0%BD%D0%B8%D0%B5-%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D1%85-%D1%81%D1%80%D0%B5%D0%B4%D1%8B)
Внедряйте переменные среды во все shell-процессы выполнения (инструменты искусственного интеллекта и пользовательские terminal):
.opencode/plugins/inject-env.js```


exportconstInjectEnvPlugin=async () => {




return {




"shell.env": async (input, output) => {




output.env.MY_API_KEY="secret"




output.env.PROJECT_ROOT= input.cwd



},


}


}

```

* * *

### [Пользовательские инструменты](https://opencode.ai/docs/plugins#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B)
Плагины также могут добавлять в opencode собственные инструменты:
.opencode/plugins/custom-tools.ts```


import { type Plugin, tool } from"@opencode-ai/plugin"




exportconstCustomToolsPlugin:Plugin=async (ctx) => {




return {



tool: {



mytool: tool({




description: "This is a custom tool",



args: {



foo: tool.schema.string(),



},



asyncexecute(args, context) {




const { directory, worktree } = context




return`Hello ${args.foo} from ${directory} (worktree: ${worktree})`



},


}),


},


}


}

```

Помощник `tool` создает собственный инструмент, который может вызывать opencode. Он принимает функцию схемы Zod и возвращает определение инструмента:
  * `description`: Что делает инструмент
  * `args`: схема Zod для аргументов инструмента.
  * `execute`: функция, которая запускается при вызове инструмента.


Ваши пользовательские инструменты будут доступны для открытия кода наряду со встроенными инструментами.
* * *

### [Ведение журнала](https://opencode.ai/docs/plugins#%D0%B2%D0%B5%D0%B4%D0%B5%D0%BD%D0%B8%D0%B5-%D0%B6%D1%83%D1%80%D0%BD%D0%B0%D0%BB%D0%B0)
Используйте `client.app.log()` вместо `console.log` для структурированного ведения журнала:
.opencode/plugins/my-plugin.ts```


exportconstMyPlugin=async ({ client }) => {




await client.app.log({



body: {



service: "my-plugin",




level: "info",




message: "Plugin initialized",




extra: { foo: "bar" },



},


})


}

```

Уровни: `debug`, `info`, `warn`, `error`. Подробности см. в документации SDK](<https://opencode.ai/docs/sdk>).
* * *

### [Хуки сжатия](https://opencode.ai/docs/plugins#%D1%85%D1%83%D0%BA%D0%B8-%D1%81%D0%B6%D0%B0%D1%82%D0%B8%D1%8F)
Настройте контекст, включаемый при сжатии сеанса:
.opencode/plugins/compaction.ts```


importtype { Plugin } from"@opencode-ai/plugin"




exportconstCompactionPlugin:Plugin=async (ctx) => {




return {




"experimental.session.compacting": async (input, output) => {



// Inject additional context into the compaction prompt



output.context.push(`

