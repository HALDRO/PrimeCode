<!-- Source: https://opencode.ai/docs/keybinds -->

[Перейти к содержимому](https://opencode.ai/docs/keybinds#_top)
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
  * [ Обзор ](https://opencode.ai/docs/keybinds#_top)
  * [ Клавиша Leader ](https://opencode.ai/docs/keybinds#%D0%BA%D0%BB%D0%B0%D0%B2%D0%B8%D1%88%D0%B0-leader)
  * [ Отключение привязки клавиш ](https://opencode.ai/docs/keybinds#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-%D0%BF%D1%80%D0%B8%D0%B2%D1%8F%D0%B7%D0%BA%D0%B8-%D0%BA%D0%BB%D0%B0%D0%B2%D0%B8%D1%88)
  * [ Шорткаты в Desktop-приложении ](https://opencode.ai/docs/keybinds#%D1%88%D0%BE%D1%80%D1%82%D0%BA%D0%B0%D1%82%D1%8B-%D0%B2-desktop-%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B8)
  * [ Shift+Enter ](https://opencode.ai/docs/keybinds#shiftenter)
    * [ Windows Terminal ](https://opencode.ai/docs/keybinds#windows-terminal)

# Сочетания клавиш
Настройте свои сочетания клавиш.
opencode имеет список сочетаний клавиш, которые вы можете настроить через конфигурацию opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"keybinds": {




"leader": "ctrl+x",




"app_exit": "ctrl+c,ctrl+d,<leader>q",




"editor_open": "<leader>e",




"theme_list": "<leader>t",




"sidebar_toggle": "<leader>b",




"scrollbar_toggle": "none",




"username_toggle": "none",




"status_view": "<leader>s",




"tool_details": "none",




"session_export": "<leader>x",




"session_new": "<leader>n",




"session_list": "<leader>l",




"session_timeline": "<leader>g",




"session_fork": "none",




"session_rename": "none",




"session_share": "none",




"session_unshare": "none",




"session_interrupt": "escape",




"session_compact": "<leader>c",




"session_child_cycle": "<leader>right",




"session_child_cycle_reverse": "<leader>left",




"session_parent": "<leader>up",




"messages_page_up": "pageup,ctrl+alt+b",




"messages_page_down": "pagedown,ctrl+alt+f",




"messages_line_up": "ctrl+alt+y",




"messages_line_down": "ctrl+alt+e",




"messages_half_page_up": "ctrl+alt+u",




"messages_half_page_down": "ctrl+alt+d",




"messages_first": "ctrl+g,home",




"messages_last": "ctrl+alt+g,end",




"messages_next": "none",




"messages_previous": "none",




"messages_copy": "<leader>y",




"messages_undo": "<leader>u",




"messages_redo": "<leader>r",




"messages_last_user": "none",




"messages_toggle_conceal": "<leader>h",




"model_list": "<leader>m",




"model_cycle_recent": "f2",




"model_cycle_recent_reverse": "shift+f2",




"model_cycle_favorite": "none",




"model_cycle_favorite_reverse": "none",




"variant_cycle": "ctrl+t",




"command_list": "ctrl+p",




"agent_list": "<leader>a",




"agent_cycle": "tab",




"agent_cycle_reverse": "shift+tab",




"input_clear": "ctrl+c",




"input_paste": "ctrl+v",




"input_submit": "return",




"input_newline": "shift+return,ctrl+return,alt+return,ctrl+j",




"input_move_left": "left,ctrl+b",




"input_move_right": "right,ctrl+f",




"input_move_up": "up",




"input_move_down": "down",




"input_select_left": "shift+left",




"input_select_right": "shift+right",




"input_select_up": "shift+up",




"input_select_down": "shift+down",




"input_line_home": "ctrl+a",




"input_line_end": "ctrl+e",




"input_select_line_home": "ctrl+shift+a",




"input_select_line_end": "ctrl+shift+e",




"input_visual_line_home": "alt+a",




"input_visual_line_end": "alt+e",




"input_select_visual_line_home": "alt+shift+a",




"input_select_visual_line_end": "alt+shift+e",




"input_buffer_home": "home",




"input_buffer_end": "end",




"input_select_buffer_home": "shift+home",




"input_select_buffer_end": "shift+end",




"input_delete_line": "ctrl+shift+d",




"input_delete_to_line_end": "ctrl+k",




"input_delete_to_line_start": "ctrl+u",




"input_backspace": "backspace,shift+backspace",




"input_delete": "ctrl+d,delete,shift+delete",




"input_undo": "ctrl+-,super+z",




"input_redo": "ctrl+.,super+shift+z",




"input_word_forward": "alt+f,alt+right,ctrl+right",




"input_word_backward": "alt+b,alt+left,ctrl+left",




"input_select_word_forward": "alt+shift+f,alt+shift+right",




"input_select_word_backward": "alt+shift+b,alt+shift+left",




"input_delete_word_forward": "alt+d,alt+delete,ctrl+delete",




"input_delete_word_backward": "ctrl+w,ctrl+backspace,alt+backspace",




"history_previous": "up",




"history_next": "down",




"terminal_suspend": "ctrl+z",




"terminal_title_toggle": "none",




"tips_toggle": "<leader>h",




"display_thinking": "none"



}


}

```

* * *