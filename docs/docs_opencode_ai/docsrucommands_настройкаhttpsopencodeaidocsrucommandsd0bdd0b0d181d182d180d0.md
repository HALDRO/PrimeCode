<!-- Source: https://opencode.ai/docs/ru/commands -->

## [Настройка](https://opencode.ai/docs/ru/commands#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете добавлять собственные команды через конфигурацию opencode или создав файлы Markdown в каталоге `commands/`.
* * *

### [JSON](https://opencode.ai/docs/ru/commands#json)
Используйте опцию `command` в вашем opencode [config](https://opencode.ai/docs/config):
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"command": {



// This becomes the name of the command



"test": {



// This is the prompt that will be sent to the LLM



"template": "Run the full test suite with coverage report and show any failures.\nFocus on the failing tests and suggest fixes.",



// This is shown as the description in the TUI



"description": "Run tests with coverage",




"agent": "build",




"model": "anthropic/claude-3-5-sonnet-20241022"



}


}


}

```

Теперь вы можете запустить эту команду в TUI:
```

/test

```

* * *

### [Markdown](https://opencode.ai/docs/ru/commands#markdown)
Вы также можете определять команды, используя Markdown файлы. Поместите их в:
  * Глобальный: `~/.config/opencode/commands/`
  * Для каждого проекта: `.opencode/commands/`


~/.config/opencode/commands/test.md```

---



description: Run tests with coverage




agent: build




model: anthropic/claude-3-5-sonnet-20241022



---


Run the full test suite with coverage report and show any failures.


Focus on the failing tests and suggest fixes.

```

Имя Markdown файла становится именем команды. Например, `test.md` позволяет вам запустить:
```

/test

```

* * *

