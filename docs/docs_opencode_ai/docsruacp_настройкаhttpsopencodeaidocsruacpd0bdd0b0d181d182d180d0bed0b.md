<!-- Source: https://opencode.ai/docs/ru/acp -->

## [Настройка](https://opencode.ai/docs/ru/acp#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Чтобы использовать opencode через ACP, настройте свой редактор для запуска команды `opencode acp`.
Команда запускает opencode как ACP-совместимый подпроцесс, который взаимодействует с вашим редактором через JSON-RPC через stdio.
Ниже приведены примеры популярных редакторов, поддерживающих ACP.
* * *

### [Zed](https://opencode.ai/docs/ru/acp#zed)
Добавьте в конфигурацию [Zed](https://zed.dev) (`~/.config/zed/settings.json`):
~/.config/zed/settings.json```

{



"agent_servers": {




"OpenCode": {




"command": "opencode",




"args": ["acp"]



}


}


}

```

Чтобы открыть его, используйте действие `agent: new thread` в **Палитре команд**.
Вы также можете привязать сочетание клавиш, отредактировав свой `keymap.json`:
keymap.json```

[


{



"bindings": {




"cmd-alt-o": [




"agent::NewExternalAgentThread",



{



"agent": {




"custom": {




"name": "OpenCode",




"command": {




"command": "opencode",




"args": ["acp"]



}


}


}


}


]


}


}


]

```

* * *

### [IDE JetBrains](https://opencode.ai/docs/ru/acp#ide-jetbrains)
Добавьте в свою [JetBrains IDE](https://www.jetbrains.com/) acp.json в соответствии с [документацией](https://www.jetbrains.com/help/ai-assistant/acp.html):
acp.json```

{



"agent_servers": {




"OpenCode": {




"command": "/absolute/path/bin/opencode",




"args": ["acp"]



}


}


}

```

Чтобы открыть его, используйте новый агент opencode в селекторе агентов AI Chat.
* * *

### [Avante.nvim](https://opencode.ai/docs/ru/acp#avantenvim)
Добавьте в свою конфигурацию [Avante.nvim](https://github.com/yetone/avante.nvim):
```

{



acp_providers = {




["opencode"] = {




command ="opencode",




args = { "acp" }



}


}


}

```

Если вам нужно передать переменные среды:
```

{



acp_providers = {




["opencode"] = {




command ="opencode",




args = { "acp" },




env = {




OPENCODE_API_KEY =os.getenv("OPENCODE_API_KEY")



}


}


}


}

```

* * *

### [CodeCompanion.nvim](https://opencode.ai/docs/ru/acp#codecompanionnvim)
Чтобы использовать opencode в качестве агента ACP в [CodeCompanion.nvim](https://github.com/olimorris/codecompanion.nvim), добавьте в конфигурацию Neovim следующее:
```


require("codecompanion").setup({




interactions = {




chat = {




adapter = {




name ="opencode",




model ="claude-sonnet-4",



},


},


},


})

```

Эта конфигурация настраивает CodeCompanion для использования opencode в качестве агента ACP для чата.
Если вам нужно передать переменные среды (например, `OPENCODE_API_KEY`), обратитесь к разделу [Настройка адаптеров: переменные среды](https://codecompanion.olimorris.dev/getting-started#setting-an-api-key) в документации CodeCompanion.nvim для получения полной информации.

