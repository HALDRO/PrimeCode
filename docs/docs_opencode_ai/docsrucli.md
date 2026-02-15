<!-- Source: https://opencode.ai/docs/ru/cli -->

[Перейти к содержимому](https://opencode.ai/docs/ru/cli#_top)
[ OpenCode  ](https://opencode.ai/docs/ru)
[app.header.home](https://opencode.ai/)[app.header.docs](https://opencode.ai/docs/)
[ ](https://github.com/anomalyco/opencode)[ ](https://opencode.ai/discord)
Поиск ` `Ctrl``K` `
Отменить 
Очистить поле
  * [ Введение ](https://opencode.ai/docs/ru/)
  * [ Конфигурация ](https://opencode.ai/docs/ru/config/)
  * [ Провайдеры ](https://opencode.ai/docs/ru/providers/)
  * [ Сеть ](https://opencode.ai/docs/ru/network/)
  * [ Корпоративное использование ](https://opencode.ai/docs/ru/enterprise/)
  * [ Поиск неисправностей ](https://opencode.ai/docs/ru/troubleshooting/)
  * [ Windows (WSL) ](https://opencode.ai/docs/ru/windows-wsl/)
  * Использование
    * [ TUI ](https://opencode.ai/docs/ru/tui/)
    * [ CLI ](https://opencode.ai/docs/ru/cli/)
    * [ Интернет ](https://opencode.ai/docs/ru/web/)
    * [ IDE ](https://opencode.ai/docs/ru/ide/)
    * [ Zen ](https://opencode.ai/docs/ru/zen/)
    * [ Делиться ](https://opencode.ai/docs/ru/share/)
    * [ GitHub ](https://opencode.ai/docs/ru/github/)
    * [ GitLab ](https://opencode.ai/docs/ru/gitlab/)
  * Настройка
    * [ Инструменты ](https://opencode.ai/docs/ru/tools/)
    * [ Правила ](https://opencode.ai/docs/ru/rules/)
    * [ Агенты ](https://opencode.ai/docs/ru/agents/)
    * [ Модели ](https://opencode.ai/docs/ru/models/)
    * [ Темы ](https://opencode.ai/docs/ru/themes/)
    * [ Сочетания клавиш ](https://opencode.ai/docs/ru/keybinds/)
    * [ Команды ](https://opencode.ai/docs/ru/commands/)
    * [ Форматтеры ](https://opencode.ai/docs/ru/formatters/)
    * [ Разрешения ](https://opencode.ai/docs/ru/permissions/)
    * [ LSP-серверы ](https://opencode.ai/docs/ru/lsp/)
    * [ MCP-серверы ](https://opencode.ai/docs/ru/mcp-servers/)
    * [ Поддержка ACP ](https://opencode.ai/docs/ru/acp/)
    * [ Навыки агента ](https://opencode.ai/docs/ru/skills/)
    * [ Пользовательские инструменты ](https://opencode.ai/docs/ru/custom-tools/)
  * Разработка
    * [ SDK ](https://opencode.ai/docs/ru/sdk/)
    * [ Сервер ](https://opencode.ai/docs/ru/server/)
    * [ Плагины ](https://opencode.ai/docs/ru/plugins/)
    * [ Экосистема ](https://opencode.ai/docs/ru/ecosystem/)


[GitHub](https://github.com/anomalyco/opencode)[Discord](https://opencode.ai/discord)
Выберите тему Тёмная Светлая Авто Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
На этой странице
Обзор 
  * [ Обзор ](https://opencode.ai/docs/ru/cli#_top)
    * [ tui ](https://opencode.ai/docs/ru/cli#tui)
  * [ Команды ](https://opencode.ai/docs/ru/cli#%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D1%8B)
    * [ agent ](https://opencode.ai/docs/ru/cli#agent)
    * [ attach ](https://opencode.ai/docs/ru/cli#attach)
    * [ auth ](https://opencode.ai/docs/ru/cli#auth)
    * [ github ](https://opencode.ai/docs/ru/cli#github)
    * [ mcp ](https://opencode.ai/docs/ru/cli#mcp)
    * [ models ](https://opencode.ai/docs/ru/cli#models)
    * [ run ](https://opencode.ai/docs/ru/cli#run-1)
    * [ serve ](https://opencode.ai/docs/ru/cli#serve)
    * [ session ](https://opencode.ai/docs/ru/cli#session)
    * [ stats ](https://opencode.ai/docs/ru/cli#stats)
    * [ export ](https://opencode.ai/docs/ru/cli#export)
    * [ import ](https://opencode.ai/docs/ru/cli#import)
    * [ web ](https://opencode.ai/docs/ru/cli#web)
    * [ acp ](https://opencode.ai/docs/ru/cli#acp)
    * [ uninstall ](https://opencode.ai/docs/ru/cli#uninstall)
    * [ upgrade ](https://opencode.ai/docs/ru/cli#upgrade)
  * [ Глобальные флаги ](https://opencode.ai/docs/ru/cli#%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D1%84%D0%BB%D0%B0%D0%B3%D0%B8)
  * [ Переменные среды ](https://opencode.ai/docs/ru/cli#%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%8B)
    * [ Экспериментальные функции ](https://opencode.ai/docs/ru/cli#%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D1%80%D0%B8%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D1%84%D1%83%D0%BD%D0%BA%D1%86%D0%B8%D0%B8)

# CLI
Параметры и команда opencode CLI.
CLI opencode по умолчанию запускает [TUI](https://opencode.ai/docs/tui) при запуске без каких-либо аргументов.
Окно терминала```

opencode

```

Но он также принимает команды, описанные на этой странице. Это позволяет вам программно взаимодействовать с opencode.
Окно терминала```


opencoderun"Explain how closures work in JavaScript"


```

* * *

# Start the backend server for web/mobile access



opencodeweb--port4096--hostname0.0.0.0

# In another terminal, attach the TUI to the running backend



opencodeattachhttp://10.20.30.40:4096


```

#### [Флаги](https://opencode.ai/docs/ru/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-1)
Флаг | Короткий | Описание  
---|---|---  
`--dir` |  | Рабочий каталог для запуска TUI  
`--session` | `-s` | Идентификатор сеанса для продолжения  
* * *
#### [create](https://opencode.ai/docs/ru/cli#create)
Создайте нового агента с пользовательской конфигурацией.
Окно терминала```


opencodeagentcreate


```

Эта команда поможет вам создать новый агент с настраиваемой системной подсказкой и настройкой инструмента.
* * *
#### [list](https://opencode.ai/docs/ru/cli#list)
Перечислите всех доступных агентов.
Окно терминала```


opencodeagentlist


```

* * *

# Start a headless server in one terminal



opencodeserve

# In another terminal, run commands that attach to it



opencoderun--attachhttp://localhost:4096"Explain async/await in JavaScript"


```

#### [Флаги](https://opencode.ai/docs/ru/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-4)
Флаг | Короткий | Описание  
---|---|---  
`--command` |  | Команда для запуска, используйте сообщение для аргументов  
`--continue` | `-c` | Продолжить последний сеанс  
`--session` | `-s` | Идентификатор сеанса для продолжения  
`--fork` |  | Разветвить сеанс при продолжении (используйте с `--continue` или `--session`)  
`--share` |  | Поделиться сеансом  
`--model` | `-m` | Модель для использования в виде поставщика/модели.  
`--agent` |  | Агент для использования  
`--file` | `-f` | Файл(ы) для прикрепления к сообщению  
`--format` |  | Формат: по умолчанию (отформатированный) или json (необработанные события JSON).  
`--title` |  | Название сеанса (использует усеченное приглашение, если значение не указано)  
`--attach` |  | Подключитесь к работающему серверу opencode (например, <http://localhost:4096>)  
`--port` |  | Порт локального сервера (по умолчанию случайный порт)  
* * *