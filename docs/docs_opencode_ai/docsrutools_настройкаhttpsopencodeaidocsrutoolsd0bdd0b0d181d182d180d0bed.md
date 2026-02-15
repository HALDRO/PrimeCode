<!-- Source: https://opencode.ai/docs/ru/tools -->

## [Настройка](https://opencode.ai/docs/ru/tools#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Используйте поле `permission` для управления поведением инструмента. Вы можете разрешить, запретить или потребовать одобрения для каждого инструмента.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"edit": "deny",




"bash": "ask",




"webfetch": "allow"



}


}

```

Вы также можете использовать подстановочные знаки для одновременного управления несколькими инструментами. Например, чтобы потребовать одобрения всех инструментов с сервера MCP:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"mymcp_*": "ask"



}


}

```

[Подробнее](https://opencode.ai/docs/permissions) о настройке разрешений.
* * *

