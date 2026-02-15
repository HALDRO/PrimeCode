<!-- Source: https://opencode.ai/docs/mcp-servers -->

## [Управление](https://opencode.ai/docs/mcp-servers#%D1%83%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5)
Ваши MCP доступны в виде инструментов opencode наряду со встроенными инструментами. Таким образом, вы можете управлять ими через конфигурацию opencode, как и любым другим инструментом.
* * *

### [Глобально](https://opencode.ai/docs/mcp-servers#%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D0%BE)
Это означает, что вы можете включать или отключать их глобально.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-mcp-foo": {




"type": "local",




"command": ["bun", "x", "my-mcp-command-foo"]



},



"my-mcp-bar": {




"type": "local",




"command": ["bun", "x", "my-mcp-command-bar"]



}


},



"tools": {




"my-mcp-foo": false



}


}

```

Мы также можем использовать шаблон glob, чтобы отключить все соответствующие MCP.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-mcp-foo": {




"type": "local",




"command": ["bun", "x", "my-mcp-command-foo"]



},



"my-mcp-bar": {




"type": "local",




"command": ["bun", "x", "my-mcp-command-bar"]



}


},



"tools": {




"my-mcp*": false



}


}

```

Здесь мы используем шаблон `my-mcp*` для отключения всех MCP.
* * *

### [Для каждого агента](https://opencode.ai/docs/mcp-servers#%D0%B4%D0%BB%D1%8F-%D0%BA%D0%B0%D0%B6%D0%B4%D0%BE%D0%B3%D0%BE-%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D0%B0)
Если у вас большое количество серверов MCP, вы можете включить их только для каждого агента и отключить глобально. Для этого:
  1. Отключите его как инструмент глобально.
  2. В вашей [конфигурации агента](https://opencode.ai/docs/agents#tools) включите сервер MCP в качестве инструмента.


opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-mcp": {




"type": "local",




"command": ["bun", "x", "my-mcp-command"],




"enabled": true



}


},



"tools": {




"my-mcp*": false



},



"agent": {




"my-agent": {




"tools": {




"my-mcp*": true



}


}


}


}

```

* * *
#### [Glob-шаблоны](https://opencode.ai/docs/mcp-servers#glob-%D1%88%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD%D1%8B)
Шаблон glob использует простые шаблоны подстановки регулярных выражений:
  * `*` соответствует нулю или более любого символа (например, `"my-mcp*"` соответствует `my-mcp_search`, `my-mcp_list` и т. д.).
  * `?` соответствует ровно одному символу.
  * Все остальные символы совпадают буквально


Инструменты сервера MCP регистрируются с именем сервера в качестве префикса, поэтому, чтобы отключить все инструменты для сервера, просто используйте:
```

"mymcpservername_*": false

```

* * *

