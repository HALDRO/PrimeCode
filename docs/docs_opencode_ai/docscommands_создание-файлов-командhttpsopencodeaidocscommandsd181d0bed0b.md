<!-- Source: https://opencode.ai/docs/commands -->

## [Создание файлов команд](https://opencode.ai/docs/commands#%D1%81%D0%BE%D0%B7%D0%B4%D0%B0%D0%BD%D0%B8%D0%B5-%D1%84%D0%B0%D0%B9%D0%BB%D0%BE%D0%B2-%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4)
Создайте Markdown файлы в каталоге `commands/` для определения пользовательских команд.
Создайте `.opencode/commands/test.md`:
.opencode/commands/test.md```

---



description: Run tests with coverage




agent: build




model: anthropic/claude-3-5-sonnet-20241022



---


Run the full test suite with coverage report and show any failures.


Focus on the failing tests and suggest fixes.

```

Фронтматтер (frontmatter) определяет свойства команды. Содержимое становится шаблоном.
Используйте команду, набрав `/`, а затем имя команды.
```

"/test"

```

* * *

