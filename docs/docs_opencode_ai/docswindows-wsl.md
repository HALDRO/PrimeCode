<!-- Source: https://opencode.ai/docs/windows-wsl -->

[Перейти к содержимому](https://opencode.ai/docs/windows-wsl#_top)
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
  * [ Обзор ](https://opencode.ai/docs/windows-wsl#_top)
  * [ Настройка ](https://opencode.ai/docs/windows-wsl#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
  * [ Десктопное приложение + сервер в WSL ](https://opencode.ai/docs/windows-wsl#%D0%B4%D0%B5%D1%81%D0%BA%D1%82%D0%BE%D0%BF%D0%BD%D0%BE%D0%B5-%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5--%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80-%D0%B2-wsl)
  * [ Веб-клиент + WSL ](https://opencode.ai/docs/windows-wsl#%D0%B2%D0%B5%D0%B1-%D0%BA%D0%BB%D0%B8%D0%B5%D0%BD%D1%82--wsl)
  * [ Доступ к файлам Windows ](https://opencode.ai/docs/windows-wsl#%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF-%D0%BA-%D1%84%D0%B0%D0%B9%D0%BB%D0%B0%D0%BC-windows)
  * [ Советы ](https://opencode.ai/docs/windows-wsl#%D1%81%D0%BE%D0%B2%D0%B5%D1%82%D1%8B)

# Windows (WSL)
Запускайте opencode в Windows через WSL.
opencode можно запускать напрямую в Windows, но для лучшего опыта мы рекомендуем [Windows Subsystem for Linux (WSL)](https://learn.microsoft.com/en-us/windows/wsl/install). WSL дает Linux-среду, которая отлично работает с возможностями opencode.
WSL дает более высокую производительность файловой системы, полноценную поддержку терминала и совместимость с инструментами разработки, на которые опирается opencode.
* * *