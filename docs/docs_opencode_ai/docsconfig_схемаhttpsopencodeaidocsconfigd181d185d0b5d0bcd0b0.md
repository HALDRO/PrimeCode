<!-- Source: https://opencode.ai/docs/config -->

## [Схема](https://opencode.ai/docs/config#%D1%81%D1%85%D0%B5%D0%BC%D0%B0)
Файл конфигурации имеет схему, определенную в [**`opencode.ai/config.json`**](https://opencode.ai/config.json).
Ваш редактор должен иметь возможность проверять и автозаполнять данные на основе схемы.
* * *

### [TUI](https://opencode.ai/docs/config#tui)
Вы можете настроить параметры TUI с помощью опции `tui`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"tui": {




"scroll_speed": 3,




"scroll_acceleration": {




"enabled": true



},



"diff_style": "auto"



}


}

```

Доступные варианты:
  * `scroll_acceleration.enabled` — включить ускорение прокрутки в стиле MacOS. **Имеет приоритет над`scroll_speed`.**
  * `scroll_speed` — пользовательский множитель скорости прокрутки (по умолчанию: `3`, минимум: `1`). Игнорируется, если `scroll_acceleration.enabled` равен `true`.
  * `diff_style` — управление рендерингом различий. `"auto"` адаптируется к ширине terminal, `"stacked"` всегда отображает один столбец.


[Подробнее об использовании TUI можно узнать здесь](https://opencode.ai/docs/tui).
* * *

### [Сервер](https://opencode.ai/docs/config#%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80)
Вы можете настроить параметры сервера для команд `opencode serve` и `opencode web` с помощью опции `server`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"server": {




"port": 4096,




"hostname": "0.0.0.0",




"mdns": true,




"mdnsDomain": "myproject.local",




"cors": ["http://localhost:5173"]



}


}

```

Доступные варианты:
  * `port` — порт для прослушивания.
  * `hostname` — имя хоста для прослушивания. Если `mdns` включен и имя хоста не задано, по умолчанию используется `0.0.0.0`.
  * `mdns` — включить обнаружение службы mDNS. Это позволит другим устройствам в сети обнаружить ваш сервер opencode.
  * `mdnsDomain` — собственное доменное имя для службы mDNS. По умолчанию `opencode.local`. Полезно для запуска нескольких экземпляров в одной сети.
  * `cors` — дополнительные источники, позволяющие использовать CORS при использовании HTTP-сервера из браузерного клиента. Значения должны быть полными источниками (схема + хост + дополнительный порт), например `https://app.example.com`.


[Подробнее о сервере можно узнать здесь](https://opencode.ai/docs/server).
* * *

### [Инструменты](https://opencode.ai/docs/config#%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B)
Вы можете управлять инструментами, которые LLM может использовать, с помощью опции `tools`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"tools": {




"write": false,




"bash": false



}


}

```

[Подробнее об инструментах можно узнать здесь](https://opencode.ai/docs/tools).
* * *

### [models](https://opencode.ai/docs/config#models)
Вы можете настроить поставщиков и модели, которые хотите использовать в своей конфигурации opencode, с помощью параметров `provider`, `model` и `small_model`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {},




"model": "anthropic/claude-sonnet-4-5",




"small_model": "anthropic/claude-haiku-4-5"



}

```

Опция `small_model` настраивает отдельную модель для облегченных задач, таких как создание заголовков. По умолчанию opencode пытается использовать более дешевую модель, если она доступна у вашего провайдера, в противном случае он возвращается к вашей основной модели.
Опции провайдера могут включать `timeout` и `setCacheKey`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"anthropic": {




"options": {




"timeout": 600000,




"setCacheKey": true



}


}


}


}

```

  * `timeout` — таймаут запроса в миллисекундах (по умолчанию: 300000). Установите `false` для отключения.
  * `setCacheKey` — убедитесь, что ключ кэша всегда установлен для назначенного поставщика.


Вы также можете настроить [локальные модели](https://opencode.ai/docs/models#local). [Подробнее ](https://opencode.ai/docs/models).
* * *
#### [Параметры, зависящие от поставщика](https://opencode.ai/docs/config#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B-%D0%B7%D0%B0%D0%B2%D0%B8%D1%81%D1%8F%D1%89%D0%B8%D0%B5-%D0%BE%D1%82-%D0%BF%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA%D0%B0)
Некоторые поставщики поддерживают дополнительные параметры конфигурации помимо общих настроек `timeout` и `apiKey`.
##### [Amazon](https://opencode.ai/docs/config#amazon)
Amazon Bedrock поддерживает конфигурацию, специфичную для AWS:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"amazon-bedrock": {




"options": {




"region": "us-east-1",




"profile": "my-aws-profile",




"endpoint": "https://bedrock-runtime.us-east-1.vpce-xxxxx.amazonaws.com"



}


}


}


}

```

  * `region` — регион AWS для Bedrock (по умолчанию переменная среды `AWS_REGION` или `us-east-1`)
  * `profile` — именованный профиль AWS из `~/.aws/credentials` (по умолчанию переменная окружения `AWS_PROFILE`)
  * `endpoint` — URL-адрес пользовательской конечной точки для конечных точек VPC. Это псевдоним общего параметра `baseURL`, использующий терминологию, специфичную для AWS. Если указаны оба параметра, `endpoint` имеет приоритет.


Токены носителя (`AWS_BEARER_TOKEN_BEDROCK` или `/connect`) имеют приоритет над аутентификацией на основе профиля. Подробности см. в [приоритет аутентификации](https://opencode.ai/docs/providers#authentication-precedence).
[Подробнее о конфигурации Amazon Bedrock](https://opencode.ai/docs/providers#amazon-bedrock).
* * *

### [theme](https://opencode.ai/docs/config#theme)
Вы можете настроить тему, которую хотите использовать, в конфигурации opencode с помощью опции `theme`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"theme": ""



}

```

[Подробнее здесь](https://opencode.ai/docs/themes).
* * *

### [agent](https://opencode.ai/docs/config#agent)
Вы можете настроить специализированные агенты для конкретных задач с помощью опции `agent`.
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"agent": {




"code-reviewer": {




"description": "Reviews code for best practices and potential issues",




"model": "anthropic/claude-sonnet-4-5",




"prompt": "You are a code reviewer. Focus on security, performance, and maintainability.",




"tools": {



// Disable file modification tools for review-only agent



"write": false,




"edit": false,



},


},


},


}

```

Вы также можете определить агентов, используя файлы Markdown в `~/.config/opencode/agents/` или `.opencode/agents/`. [Подробнее здесь](https://opencode.ai/docs/agents).
* * *

### [default_agent](https://opencode.ai/docs/config#default_agent)
Вы можете установить агента по умолчанию, используя опцию `default_agent`. Это определяет, какой агент используется, если ни один из них не указан явно.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"default_agent": "plan"



}

```

Агент по умолчанию должен быть основным агентом (а не субагентом). Это может быть встроенный агент, например `"build"` или `"plan"`, или [пользовательский агент](https://opencode.ai/docs/agents), который вы определили. Если указанный агент не существует или является субагентом, opencode вернется к `"build"` с предупреждением.
Этот параметр применяется ко всем интерфейсам: TUI, CLI (`opencode run`), настольному приложению и действию GitHub.
* * *

### [share](https://opencode.ai/docs/config#share)
Функцию [share](https://opencode.ai/docs/share) можно настроить с помощью опции `share`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"share": "manual"



}

```

Принимает значения:
  * `"manual"` — разрешить общий доступ вручную с помощью команд (по умолчанию).
  * `"auto"` — автоматически делиться новыми беседами.
  * `"disabled"` — полностью отключить общий доступ


По умолчанию общий доступ установлен в ручной режим, в котором вам необходимо явно делиться разговорами с помощью команды `/share`.
* * *

### [Команды](https://opencode.ai/docs/config#%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D1%8B)
Вы можете настроить собственные команды для повторяющихся задач с помощью опции `command`.
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"command": {




"test": {




"template": "Run the full test suite with coverage report and show any failures.\nFocus on the failing tests and suggest fixes.",




"description": "Run tests with coverage",




"agent": "build",




"model": "anthropic/claude-haiku-4-5",



},



"component": {




"template": "Create a new React component named $ARGUMENTS with TypeScript support.\nInclude proper typing and basic structure.",




"description": "Create a new component",



},


},


}

```

Вы также можете определять команды, используя файлы Markdown в `~/.config/opencode/commands/` или `.opencode/commands/`. [Подробнее здесь](https://opencode.ai/docs/commands).
* * *

### [Сочетания клавиш](https://opencode.ai/docs/config#%D1%81%D0%BE%D1%87%D0%B5%D1%82%D0%B0%D0%BD%D0%B8%D1%8F-%D0%BA%D0%BB%D0%B0%D0%B2%D0%B8%D1%88)
Вы можете настроить привязки клавиш с помощью опции `keybinds`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"keybinds": {}



}

```

[Подробнее здесь](https://opencode.ai/docs/keybinds).
* * *

### [Автообновление](https://opencode.ai/docs/config#%D0%B0%D0%B2%D1%82%D0%BE%D0%BE%D0%B1%D0%BD%D0%BE%D0%B2%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5)
opencode автоматически загрузит все новые обновления при запуске. Вы можете отключить это с помощью опции `autoupdate`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"autoupdate": false



}

```

Если вы не хотите получать обновления, но хотите получать уведомления о появлении новой версии, установите для `autoupdate` значение `"notify"`. Обратите внимание, что это работает только в том случае, если оно было установлено без использования менеджера пакетов, такого как Homebrew.
* * *

### [Форматтеры](https://opencode.ai/docs/config#%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D1%82%D0%B5%D1%80%D1%8B)
Вы можете настроить форматировщики кода с помощью опции `formatter`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"formatter": {




"prettier": {




"disabled": true



},



"custom-prettier": {




"command": ["npx", "prettier", "--write", "$FILE"],




"environment": {




"NODE_ENV": "development"



},



"extensions": [".js", ".ts", ".jsx", ".tsx"]



}


}


}

```

[Подробнее о форматтерах можно узнать здесь](https://opencode.ai/docs/formatters).
* * *

### [permission](https://opencode.ai/docs/config#permission)
По умолчанию opencode **разрешает все операции** , не требуя явного разрешения. Вы можете изменить это, используя опцию `permission`.
Например, чтобы гарантировать, что инструменты `edit` и `bash` требуют одобрения пользователя:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"edit": "ask",




"bash": "ask"



}


}

```

[Подробнее о разрешениях можно узнать здесь](https://opencode.ai/docs/permissions).
* * *

### [compaction](https://opencode.ai/docs/config#compaction)
Вы можете управлять поведением сжатия контекста с помощью опции `compaction`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"compaction": {




"auto": true,




"prune": true



}


}

```

  * `auto` — автоматически сжимать сеанс при заполнении контекста (по умолчанию: `true`).
  * `prune` — удалить старые выходные данные инструмента для сохранения токенов (по умолчанию: `true`).


* * *

### [watcher](https://opencode.ai/docs/config#watcher)
Вы можете настроить шаблоны игнорирования средства отслеживания файлов с помощью опции `watcher`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"watcher": {




"ignore": ["node_modules/**", "dist/**", ".git/**"]



}


}

```

Шаблоны соответствуют синтаксису glob. Используйте это, чтобы исключить зашумленные каталоги из просмотра файлов.
* * *

### [mcp](https://opencode.ai/docs/config#mcp)
Вы можете настроить серверы MCP, которые хотите использовать, с помощью опции `mcp`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"mcp": {}



}

```

[Подробнее здесь](https://opencode.ai/docs/mcp-servers).
* * *

### [Плагины](https://opencode.ai/docs/config#%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD%D1%8B)
[Плагины](https://opencode.ai/docs/plugins) расширяют opencode с помощью пользовательских инструментов, перехватчиков и интеграций.
Поместите файлы плагина в `.opencode/plugins/` или `~/.config/opencode/plugins/`. Вы также можете загружать плагины из npm с помощью опции `plugin`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"plugin": ["opencode-helicone-session", "@my-org/custom-plugin"]



}

```

[Подробнее здесь](https://opencode.ai/docs/plugins).
* * *

### [instructions](https://opencode.ai/docs/config#instructions)
Вы можете настроить инструкции для используемой вами модели с помощью опции `instructions`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"]



}

```

Для этого требуется массив путей и шаблонов glob для файлов инструкций. [Подробнее о правилах читайте здесь](https://opencode.ai/docs/rules).
* * *

### [disabled_providers](https://opencode.ai/docs/config#disabled_providers)
Вы можете отключить поставщиков, которые загружаются автоматически, с помощью опции `disabled_providers`. Это полезно, если вы хотите запретить загрузку определенных поставщиков, даже если их учетные данные доступны.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"disabled_providers": ["openai", "gemini"]



}

```

`disabled_providers` имеет приоритет над `enabled_providers`.
Опция `disabled_providers` принимает массив идентификаторов поставщиков. Когда провайдер отключен:
  * Он не будет загружен, даже если установлены переменные среды.
  * Он не будет загружен, даже если ключи API настроены с помощью команды `/connect`.
  * Модели поставщика не появятся в списке выбора моделей.


* * *

### [enabled_providers](https://opencode.ai/docs/config#enabled_providers)
Вы можете указать белый список поставщиков с помощью опции `enabled_providers`. Если этот параметр установлен, будут включены только указанные поставщики, а все остальные будут игнорироваться.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"enabled_providers": ["anthropic", "openai"]



}

```

Это полезно, если вы хотите ограничить opencode использованием только определенных поставщиков, а не отключать их по одному.
`disabled_providers` имеет приоритет над `enabled_providers`.
Если поставщик указан как в `enabled_providers`, так и в `disabled_providers`, `disabled_providers` имеет приоритет для обратной совместимости.
* * *

### [Экспериментальные возможности](https://opencode.ai/docs/config#%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D1%80%D0%B8%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D0%B2%D0%BE%D0%B7%D0%BC%D0%BE%D0%B6%D0%BD%D0%BE%D1%81%D1%82%D0%B8)
Ключ `experimental` содержит параметры, находящиеся в активной разработке.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"experimental": {}



}

```

Экспериментальные варианты не стабильны. Они могут быть изменены или удалены без предварительного уведомления.
* * *

