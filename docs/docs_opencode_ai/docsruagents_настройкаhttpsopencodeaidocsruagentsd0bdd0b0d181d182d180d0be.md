<!-- Source: https://opencode.ai/docs/ru/agents -->

## [Настройка](https://opencode.ai/docs/ru/agents#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете настроить встроенные агенты или создать свои собственные посредством настройки. Агенты можно настроить двумя способами:
* * *

### [JSON](https://opencode.ai/docs/ru/agents#json)
Настройте агентов в файле конфигурации `opencode.json`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"agent": {




"build": {




"mode": "primary",




"model": "anthropic/claude-sonnet-4-20250514",




"prompt": "{file:./prompts/build.txt}",




"tools": {




"write": true,




"edit": true,




"bash": true



}


},



"plan": {




"mode": "primary",




"model": "anthropic/claude-haiku-4-20250514",




"tools": {




"write": false,




"edit": false,




"bash": false



}


},



"code-reviewer": {




"description": "Reviews code for best practices and potential issues",




"mode": "subagent",




"model": "anthropic/claude-sonnet-4-20250514",




"prompt": "You are a code reviewer. Focus on security, performance, and maintainability.",




"tools": {




"write": false,




"edit": false



}


}


}


}

```

* * *

### [Markdown](https://opencode.ai/docs/ru/agents#markdown)
Вы также можете определить агентов, используя файлы Markdown. Поместите их в:
  * Глобальный: `~/.config/opencode/agents/`
  * Для каждого проекта: `.opencode/agents/`


~/.config/opencode/agents/review.md```

---



description: Reviews code for quality and best practices




mode: subagent




model: anthropic/claude-sonnet-4-20250514




temperature: 0.1




tools:




write: false




edit: false




bash: false



---


You are in code review mode. Focus on:



- Code quality and best practices




- Potential bugs and edge cases




- Performance implications




- Security considerations



Provide constructive feedback without making direct changes.

```

Имя Markdown файла становится именем агента. Например, `review.md` создает агент `review`.
* * *

