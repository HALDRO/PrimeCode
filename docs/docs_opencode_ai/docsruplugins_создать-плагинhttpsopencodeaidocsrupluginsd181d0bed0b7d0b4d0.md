<!-- Source: https://opencode.ai/docs/ru/plugins -->

## [Создать плагин](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B7%D0%B4%D0%B0%D1%82%D1%8C-%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD)
Плагин — это **модуль JavaScript/TypeScript** , который экспортирует один или несколько плагинов. функции. Каждая функция получает объект контекста и возвращает объект перехватчика.
* * *

### [Зависимости](https://opencode.ai/docs/ru/plugins#%D0%B7%D0%B0%D0%B2%D0%B8%D1%81%D0%B8%D0%BC%D0%BE%D1%81%D1%82%D0%B8)
Локальные плагины и специальные инструменты могут использовать внешние пакеты npm. Добавьте `package.json` в каталог конфигурации с необходимыми вам зависимостями.
.opencode/package.json```

{



"dependencies": {




"shescape": "^2.1.0"



}


}

```

opencode запускает `bun install` при запуске для их установки. Затем ваши плагины и инструменты смогут импортировать их.
.opencode/plugins/my-plugin.ts```


import { escape } from"shescape"




exportconstMyPlugin=async (ctx) => {




return {




"tool.execute.before": async (input, output) => {




if (input.tool ==="bash") {




output.args.command =escape(output.args.command)



}


},


}


}

```

* * *

### [Базовая структура](https://opencode.ai/docs/ru/plugins#%D0%B1%D0%B0%D0%B7%D0%BE%D0%B2%D0%B0%D1%8F-%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%82%D1%83%D1%80%D0%B0)
.opencode/plugins/example.js```


exportconstMyPlugin=async ({ project, client, $, directory, worktree }) => {




console.log("Plugin initialized!")




return {



// Hook implementations go here


}


}

```

Функция плагина получает:
  * `project`: Текущая информация о проекте.
  * `directory`: текущий рабочий каталог.
  * `worktree`: путь к рабочему дереву git.
  * `client`: клиент SDK с открытым кодом для взаимодействия с ИИ.
  * `$`: [Bun shell API](https://bun.com/docs/runtime/shell) для выполнения команд.


* * *

### [Поддержка TypeScript](https://opencode.ai/docs/ru/plugins#%D0%BF%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%BA%D0%B0-typescript)
Для плагинов TypeScript вы можете импортировать типы из пакета плагина:
my-plugin.ts```


importtype { Plugin } from"@opencode-ai/plugin"




exportconstMyPlugin:Plugin=async ({ project, client, $, directory, worktree }) => {




return {



// Type-safe hook implementations


}


}

```

* * *

### [События](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F)
Плагины могут подписываться на события, как показано ниже в разделе «Примеры». Вот список различных доступных событий.
#### [Командные события](https://opencode.ai/docs/ru/plugins#%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D0%BD%D1%8B%D0%B5-%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F)
  * `command.executed`


#### [События файла](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D1%84%D0%B0%D0%B9%D0%BB%D0%B0)
  * `file.edited`
  * `file.watcher.updated`


#### [События установки](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%BA%D0%B8)
  * `installation.updated`


#### [События LSP](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-lsp)
  * `lsp.client.diagnostics`
  * `lsp.updated`


#### [События сообщений](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D1%81%D0%BE%D0%BE%D0%B1%D1%89%D0%B5%D0%BD%D0%B8%D0%B9)
  * `message.part.removed`
  * `message.part.updated`
  * `message.removed`
  * `message.updated`


#### [События разрешения](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D1%80%D0%B0%D0%B7%D1%80%D0%B5%D1%88%D0%B5%D0%BD%D0%B8%D1%8F)
  * `permission.asked`
  * `permission.replied`


#### [События сервера](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D0%B0)
  * `server.connected`


#### [События сессии](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D1%81%D0%B5%D1%81%D1%81%D0%B8%D0%B8)
  * `session.created`
  * `session.compacted`
  * `session.deleted`
  * `session.diff`
  * `session.error`
  * `session.idle`
  * `session.status`
  * `session.updated`


#### [События](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-1)
  * `todo.updated`


#### [События shell](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-shell)
  * `shell.env`


#### [События инструмента](https://opencode.ai/docs/ru/plugins#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%B0)
  * `tool.execute.after`
  * `tool.execute.before`


#### [Мероприятия TUI](https://opencode.ai/docs/ru/plugins#%D0%BC%D0%B5%D1%80%D0%BE%D0%BF%D1%80%D0%B8%D1%8F%D1%82%D0%B8%D1%8F-tui)
  * `tui.prompt.append`
  * `tui.command.execute`
  * `tui.toast.show`


* * *

