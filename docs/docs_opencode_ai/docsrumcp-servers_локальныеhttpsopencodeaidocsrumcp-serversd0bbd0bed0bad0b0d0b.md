<!-- Source: https://opencode.ai/docs/ru/mcp-servers -->

## [Локальные](https://opencode.ai/docs/ru/mcp-servers#%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5)
Добавьте локальные серверы MCP с помощью `type` в `"local"` внутри объекта MCP.
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-local-mcp-server": {




"type": "local",



// Or ["bun", "x", "my-mcp-command"]



"command": ["npx", "-y", "my-mcp-command"],




"enabled": true,




"environment": {




"MY_ENV_VAR": "my_env_var_value",



},


},


},


}

```

Эта команда запускает локальный сервер MCP. Вы также можете передать список переменных среды.
Например, вот как можно добавить тестовый сервер [`@modelcontextprotocol/server-everything`](https://www.npmjs.com/package/@modelcontextprotocol/server-everything) MCP.
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"mcp_everything": {




"type": "local",




"command": ["npx", "-y", "@modelcontextprotocol/server-everything"],



},


},


}

```

И чтобы использовать его, добавьте `use the mcp_everything tool` в свои подсказки.
```


use the mcp_everything tool to add the number 3 and 4


```

* * *
#### [Параметры](https://opencode.ai/docs/ru/mcp-servers#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B)
Вот все варианты настройки локального сервера MCP.
Вариант | Тип | Обязательный | Описание  
---|---|---|---  
`type` | Строка | Да | Тип подключения к серверу MCP должен быть `"local"`.  
`command` | Массив | Да | Команда и аргументы для запуска сервера MCP.  
`environment` | Объект |  | Переменные среды, которые необходимо установить при запуске сервера.  
`enabled` | логическое значение |  | Включите или отключите сервер MCP при запуске.  
`timeout` | Число |  | Тайм-аут в мс для получения инструментов с сервера MCP. По умолчанию 5000 (5 секунд).  
* * *

