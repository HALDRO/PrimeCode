<!-- Source: https://opencode.ai/docs/mcp-servers -->

## [Примеры](https://opencode.ai/docs/mcp-servers#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B)
Ниже приведены примеры некоторых распространенных серверов MCP. Вы можете отправить PR, если хотите документировать другие серверы.
* * *

### [Sentry](https://opencode.ai/docs/mcp-servers#sentry)
Добавьте [сервер Sentry MCP](https://mcp.sentry.dev) для взаимодействия с вашими проектами и проблемами Sentry.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"sentry": {




"type": "remote",




"url": "https://mcp.sentry.dev/mcp",




"oauth": {}



}


}


}

```

После добавления конфигурации пройдите аутентификацию с помощью Sentry:
Окно терминала```


opencodemcpauthsentry


```

Откроется окно браузера для завершения процесса OAuth и подключения opencode к вашей учетной записи Sentry.
После аутентификации вы можете использовать инструменты Sentry в своих подсказках для запроса данных о проблемах, проектах и ​​ошибках.
```


Show me the latest unresolved issues in my project. use sentry


```

* * *

### [Context7](https://opencode.ai/docs/mcp-servers#context7)
Добавьте [сервер Context7 MCP](https://github.com/upstash/context7) для поиска в документах.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"context7": {




"type": "remote",




"url": "https://mcp.context7.com/mcp"



}


}


}

```

Если вы зарегистрировали бесплатную учетную запись, вы можете использовать свой ключ API и получить более высокие ограничения скорости.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"context7": {




"type": "remote",




"url": "https://mcp.context7.com/mcp",




"headers": {




"CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"



}


}


}


}

```

Здесь мы предполагаем, что у вас установлена ​​переменная среды `CONTEXT7_API_KEY`.
Добавьте `use context7` в запросы на использование сервера Context7 MCP.
```


Configure a Cloudflare Worker script to cache JSON API responses for five minutes. use context7


```

Альтернативно вы можете добавить что-то подобное в свой файл [AGENTS.md](https://opencode.ai/docs/rules/).
AGENTS.md```


When you need to search docs, use `context7` tools.


```

* * *

### [Grep by Vercel](https://opencode.ai/docs/mcp-servers#grep-by-vercel)
Добавьте сервер MCP [Grep от Vercel](https://grep.app) для поиска по фрагментам кода на GitHub.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {




"gh_grep": {




"type": "remote",




"url": "https://mcp.grep.app"



}


}


}

```

Поскольку мы назвали наш сервер MCP `gh_grep`, вы можете добавить `use the gh_grep tool` в свои запросы, чтобы агент мог его использовать.
```


What's the right way to set a custom domain in an SST Astro component? use the gh_grep tool


```

Альтернативно вы можете добавить что-то подобное в свой файл [AGENTS.md](https://opencode.ai/docs/rules/).
AGENTS.md```


If you are unsure how to do something, use `gh_grep` to search code examples from GitHub.


```

[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/mcp-servers.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

