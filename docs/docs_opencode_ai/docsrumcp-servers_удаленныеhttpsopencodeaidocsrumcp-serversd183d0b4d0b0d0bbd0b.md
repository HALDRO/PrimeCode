<!-- Source: https://opencode.ai/docs/ru/mcp-servers -->

## [Удаленные](https://opencode.ai/docs/ru/mcp-servers#%D1%83%D0%B4%D0%B0%D0%BB%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5)
Добавьте удаленные серверы MCP, установив для `type` значение `"remote"`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-remote-mcp": {




"type": "remote",




"url": "https://my-mcp-server.com",




"enabled": true,




"headers": {




"Authorization": "Bearer MY_API_KEY"



}


}


}


}

```

`url` — это URL-адрес удаленного сервера MCP, а с помощью параметра `headers` вы можете передать список заголовков.
* * *
#### [Параметры](https://opencode.ai/docs/ru/mcp-servers#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B-1)
Вариант | Тип | Обязательный | Описание  
---|---|---|---  
`type` | Строка | Да | Тип подключения к серверу MCP должен быть `"remote"`.  
`url` | Строка | Да | URL-адрес удаленного сервера MCP.  
`enabled` | логическое значение |  | Включите или отключите сервер MCP при запуске.  
`headers` | Объект |  | Заголовки для отправки с запросом.  
`oauth` | Объект |  | Конфигурация аутентификации OAuth. См. раздел [OAuth](https://opencode.ai/docs/ru/mcp-servers#oauth) ниже.  
`timeout` | Число |  | Тайм-аут в мс для получения инструментов с сервера MCP. По умолчанию 5000 (5 секунд).  
* * *

