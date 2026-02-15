<!-- Source: https://opencode.ai/docs/cli -->

## [Переменные среды](https://opencode.ai/docs/cli#%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%8B)
opencode можно настроить с помощью переменных среды.
Переменная | Тип | Описание  
---|---|---  
`OPENCODE_AUTO_SHARE` | логическое значение | Автоматически делиться сеансами  
`OPENCODE_GIT_BASH_PATH` | строка | Путь к исполняемому файлу Git Bash в Windows  
`OPENCODE_CONFIG` | строка | Путь к файлу конфигурации  
`OPENCODE_CONFIG_DIR` | строка | Путь к каталогу конфигурации  
`OPENCODE_CONFIG_CONTENT` | строка | Встроенное содержимое конфигурации json  
`OPENCODE_DISABLE_AUTOUPDATE` | логическое значение | Отключить автоматическую проверку обновлений  
`OPENCODE_DISABLE_PRUNE` | логическое значение | Отключить удаление старых данных  
`OPENCODE_DISABLE_TERMINAL_TITLE` | логическое значение | Отключить автоматическое обновление заголовка терминала  
`OPENCODE_PERMISSION` | строка | Встроенная конфигурация разрешений json  
`OPENCODE_DISABLE_DEFAULT_PLUGINS` | логическое значение | Отключить плагины по умолчанию  
`OPENCODE_DISABLE_LSP_DOWNLOAD` | логическое значение | Отключить автоматическую загрузку LSP-сервера  
`OPENCODE_ENABLE_EXPERIMENTAL_MODELS` | логическое значение | Включить экспериментальные модели  
`OPENCODE_DISABLE_AUTOCOMPACT` | логическое значение | Отключить автоматическое сжатие контекста  
`OPENCODE_DISABLE_CLAUDE_CODE` | логическое значение | Отключить чтение из `.claude` (подсказка + навыки)  
`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` | логическое значение | Отключить чтение `~/.claude/CLAUDE.md`  
`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | логическое значение | Отключить загрузку `.claude/skills`  
`OPENCODE_DISABLE_MODELS_FETCH` | логическое значение | Отключить получение моделей из удаленных источников  
`OPENCODE_FAKE_VCS` | строка | Поддельный поставщик VCS для целей тестирования  
`OPENCODE_DISABLE_FILETIME_CHECK` | логическое значение | Отключить проверку времени файла для оптимизации  
`OPENCODE_CLIENT` | строка | Идентификатор клиента (по умолчанию `cli`)  
`OPENCODE_ENABLE_EXA` | логическое значение | Включить инструменты веб-поиска Exa  
`OPENCODE_SERVER_PASSWORD` | строка | Включить базовую аутентификацию для `serve`/`web`  
`OPENCODE_SERVER_USERNAME` | строка | Переопределить имя пользователя базовой аутентификации (по умолчанию `opencode`)  
`OPENCODE_MODELS_URL` | строка | Пользовательский URL-адрес для получения конфигурации модели  
* * *

### [Экспериментальные функции](https://opencode.ai/docs/cli#%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D1%80%D0%B8%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D1%84%D1%83%D0%BD%D0%BA%D1%86%D0%B8%D0%B8)
Эти переменные среды позволяют использовать экспериментальные функции, которые могут быть изменены или удалены.
Переменная | Тип | Описание  
---|---|---  
`OPENCODE_EXPERIMENTAL` | логическое значение | Включить все экспериментальные функции  
`OPENCODE_EXPERIMENTAL_ICON_DISCOVERY` | логическое значение | Включить обнаружение значков  
`OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` | логическое значение | Отключить копирование при выборе в TUI  
`OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | число | Таймаут по умолчанию для команд bash в мс  
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | число | Максимальное количество токенов вывода для ответов LLM  
`OPENCODE_EXPERIMENTAL_FILEWATCHER` | логическое значение | Включить просмотр файлов для всего каталога  
`OPENCODE_EXPERIMENTAL_OXFMT` | логическое значение | Включить форматтер oxfmt  
`OPENCODE_EXPERIMENTAL_LSP_TOOL` | логическое значение | Включить экспериментальный инструмент LSP  
`OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` | логическое значение | Отключить просмотрщик файлов  
`OPENCODE_EXPERIMENTAL_EXA` | логическое значение | Включить экспериментальные функции Exa  
`OPENCODE_EXPERIMENTAL_LSP_TY` | логическое значение | Включить экспериментальную проверку типа LSP  
`OPENCODE_EXPERIMENTAL_MARKDOWN` | логическое значение | Включить экспериментальные функции Markdown  
`OPENCODE_EXPERIMENTAL_PLAN_MODE` | логическое значение | Включить режим плана  
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/cli.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

