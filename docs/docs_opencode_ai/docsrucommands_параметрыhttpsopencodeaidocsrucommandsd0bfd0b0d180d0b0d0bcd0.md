<!-- Source: https://opencode.ai/docs/ru/commands -->

## [Параметры](https://opencode.ai/docs/ru/commands#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B)
Рассмотрим варианты конфигурации подробнее.
* * *

### [Template](https://opencode.ai/docs/ru/commands#template)
Параметр `template` определяет приглашение, которое будет отправлено в LLM при выполнении команды.
opencode.json```

{



"command": {




"test": {




"template": "Run the full test suite with coverage report and show any failures.\nFocus on the failing tests and suggest fixes."



}


}


}

```

Это **обязательный** параметр конфигурации.
* * *

### [Описание](https://opencode.ai/docs/ru/commands#%D0%BE%D0%BF%D0%B8%D1%81%D0%B0%D0%BD%D0%B8%D0%B5)
Используйте опцию `description`, чтобы предоставить краткое описание того, что делает команда.
opencode.json```

{



"command": {




"test": {




"description": "Run tests with coverage"



}


}


}

```

Это отображается в виде описания в TUI при вводе команды.
* * *

### [Агент](https://opencode.ai/docs/ru/commands#%D0%B0%D0%B3%D0%B5%D0%BD%D1%82)
Используйте конфигурацию `agent`, чтобы дополнительно указать, какой [агент](https://opencode.ai/docs/agents) должен выполнить эту команду. Если это [subagent](https://opencode.ai/docs/agents/#subagents), команда по умолчанию инициирует вызов субагента. Чтобы отключить это поведение, установите для `subtask` значение `false`.
opencode.json```

{



"command": {




"review": {




"agent": "plan"



}


}


}

```

Это **необязательный** параметр конфигурации. Если не указано, по умолчанию используется текущий агент.
* * *

### [Subtask](https://opencode.ai/docs/ru/commands#subtask)
Используйте логическое значение `subtask`, чтобы заставить команду инициировать вызов [subagent](https://opencode.ai/docs/agents/#subagents). Это полезно, если вы хотите, чтобы команда не загрязняла ваш основной контекст и **заставляла** агента действовать как субагент. даже если для `mode` установлено значение `primary` в конфигурации [agent](https://opencode.ai/docs/agents).
opencode.json```

{



"command": {




"analyze": {




"subtask": true



}


}


}

```

Это **необязательный** параметр конфигурации.
* * *

### [Модель](https://opencode.ai/docs/ru/commands#%D0%BC%D0%BE%D0%B4%D0%B5%D0%BB%D1%8C)
Используйте конфигурацию `model`, чтобы переопределить модель по умолчанию для этой команды.
opencode.json```

{



"command": {




"analyze": {




"model": "anthropic/claude-3-5-sonnet-20241022"



}


}


}

```

Это **необязательный** параметр конфигурации.
* * *

