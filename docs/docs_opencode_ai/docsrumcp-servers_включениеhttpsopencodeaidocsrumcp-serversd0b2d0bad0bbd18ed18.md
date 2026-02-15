<!-- Source: https://opencode.ai/docs/ru/mcp-servers -->

## [Включение](https://opencode.ai/docs/ru/mcp-servers#%D0%B2%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5)
Вы можете определить серверы MCP в своем [opencode Config](https://opencode.ai/docs/config/) в разделе `mcp`. Добавьте каждому MCP уникальное имя. Вы можете обратиться к этому MCP по имени при запросе LLM.
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"name-of-mcp-server": {



// ...



"enabled": true,



},



"name-of-other-mcp-server": {



// ...


},


},


}

```

Вы также можете отключить сервер, установив для `enabled` значение `false`. Это полезно, если вы хотите временно отключить сервер, не удаляя его из конфигурации.
* * *

### [Переопределение удаленных настроек по умолчанию](https://opencode.ai/docs/ru/mcp-servers#%D0%BF%D0%B5%D1%80%D0%B5%D0%BE%D0%BF%D1%80%D0%B5%D0%B4%D0%B5%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5-%D1%83%D0%B4%D0%B0%D0%BB%D0%B5%D0%BD%D0%BD%D1%8B%D1%85-%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B5%D0%BA-%D0%BF%D0%BE-%D1%83%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D0%BD%D0%B8%D1%8E)
Организации могут предоставлять серверы MCP по умолчанию через свою конечную точку `.well-known/opencode`. Эти серверы могут быть отключены по умолчанию, что позволяет пользователям выбирать те, которые им нужны.
Чтобы включить определенный сервер из удаленной конфигурации вашей организации, добавьте его в локальную конфигурацию с помощью `enabled: true`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"jira": {




"type": "remote",




"url": "https://jira.example.com/mcp",




"enabled": true



}


}


}

```

Значения вашей локальной конфигурации переопределяют удаленные значения по умолчанию. Дополнительную информацию см. в [приоритете конфигурации](https://opencode.ai/docs/config#precedence-order).
* * *

