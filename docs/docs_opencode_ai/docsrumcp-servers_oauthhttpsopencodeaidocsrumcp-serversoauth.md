<!-- Source: https://opencode.ai/docs/ru/mcp-servers -->

## [OAuth](https://opencode.ai/docs/ru/mcp-servers#oauth)
opencode автоматически обрабатывает аутентификацию OAuth для удаленных серверов MCP. Когда серверу требуется аутентификация, opencode:
  1. Обнаружьте ответ 401 и инициируйте поток OAuth.
  2. Используйте **Динамическую регистрацию клиента (RFC 7591)** , если это поддерживается сервером.
  3. Надежно храните токены для будущих запросов


* * *

### [Автоматически](https://opencode.ai/docs/ru/mcp-servers#%D0%B0%D0%B2%D1%82%D0%BE%D0%BC%D0%B0%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B8)
Для большинства серверов MCP с поддержкой OAuth не требуется никакой специальной настройки. Просто настройте удаленный сервер:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-oauth-server": {




"type": "remote",




"url": "https://mcp.example.com/mcp"



}


}


}

```

Если сервер требует аутентификации, opencode предложит вам пройти аутентификацию при первой попытке его использования. Если нет, вы можете [вручную запустить поток ](https://opencode.ai/docs/ru/mcp-servers#authenticating) с помощью `opencode mcp auth <server-name>`.
* * *

### [Предварительная регистрация](https://opencode.ai/docs/ru/mcp-servers#%D0%BF%D1%80%D0%B5%D0%B4%D0%B2%D0%B0%D1%80%D0%B8%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%B0%D1%8F-%D1%80%D0%B5%D0%B3%D0%B8%D1%81%D1%82%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
Если у вас есть учетные данные клиента от поставщика сервера MCP, вы можете их настроить:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-oauth-server": {




"type": "remote",




"url": "https://mcp.example.com/mcp",




"oauth": {




"clientId": "{env:MY_MCP_CLIENT_ID}",




"clientSecret": "{env:MY_MCP_CLIENT_SECRET}",




"scope": "tools:read tools:execute"



}


}


}


}

```

* * *

### [Аутентификация](https://opencode.ai/docs/ru/mcp-servers#%D0%B0%D1%83%D1%82%D0%B5%D0%BD%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
Вы можете вручную активировать аутентификацию или управлять учетными данными.
Аутентификация с помощью определенного сервера MCP:
Окно терминала```


opencodemcpauthmy-oauth-server


```

Перечислите все серверы MCP и их статус аутентификации:
Окно терминала```


opencodemcplist


```

Удалить сохраненные учетные данные:
Окно терминала```


opencodemcplogoutmy-oauth-server


```

Команда `mcp auth` откроет ваш браузер для авторизации. После того как вы авторизуетесь, opencode надежно сохранит токены в `~/.local/share/opencode/mcp-auth.json`.
* * *
#### [Отключение OAuth](https://opencode.ai/docs/ru/mcp-servers#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-oauth)
Если вы хотите отключить автоматический OAuth для сервера (например, для серверов, которые вместо этого используют ключи API), установите для `oauth` значение `false`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"my-api-key-server": {




"type": "remote",




"url": "https://mcp.example.com/mcp",




"oauth": false,




"headers": {




"Authorization": "Bearer {env:MY_API_KEY}"



}


}


}


}

```

* * *
#### [Параметры OAuth](https://opencode.ai/docs/ru/mcp-servers#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B-oauth)
Вариант | Тип | Описание  
---|---|---  
`oauth` | Object | false | Объект конфигурации OAuth или `false`, чтобы отключить автообнаружение OAuth.  
`clientId` | String | OAuth client ID. Если не указан, будет выполнена динамическая регистрация клиента.  
`clientSecret` | String | OAuth client secret, если этого требует сервер авторизации.  
`scope` | String | OAuth scopes для запроса во время авторизации.  
#### [Отладка](https://opencode.ai/docs/ru/mcp-servers#%D0%BE%D1%82%D0%BB%D0%B0%D0%B4%D0%BA%D0%B0)
Если удаленный сервер MCP не может аутентифицироваться, вы можете диагностировать проблемы с помощью:
Окно терминала```

