<!-- Source: https://opencode.ai/docs/commands -->

## [Настройка промпта](https://opencode.ai/docs/commands#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0-%D0%BF%D1%80%D0%BE%D0%BC%D0%BF%D1%82%D0%B0)
Подсказки для пользовательских команд поддерживают несколько специальных заполнителей и синтаксиса.
* * *

### [Аргументы](https://opencode.ai/docs/commands#%D0%B0%D1%80%D0%B3%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B)
Передавайте аргументы командам, используя заполнитель `$ARGUMENTS`.
.opencode/commands/component.md```

---



description: Create a new component



---


Create a new React component named $ARGUMENTS with TypeScript support.


Include proper typing and basic structure.

```

Запустите команду с аргументами:
```


/componentButton


```

И `$ARGUMENTS` будет заменен на `Button`.
Вы также можете получить доступ к отдельным аргументам, используя позиционные параметры:
  * `$1` — первый аргумент
  * `$2` — Второй аргумент
  * `$3` — Третий аргумент
  * И так далее…


Например:
.opencode/commands/create-file.md```

---



description: Create a new file with content



---


Create a file named $1 in the directory $2


with the following content: $3

```

Запустите команду:
```


/create-fileconfig.jsonsrc"{ \"key\": \"value\" }"


```

Это заменяет:
  * `$1` с `config.json`
  * `$2` с `src`
  * `$3` с `{ "key": "value" }`


* * *

### [Вывод shell](https://opencode.ai/docs/commands#%D0%B2%D1%8B%D0%B2%D0%BE%D0%B4-shell)
Используйте _!`command`_ , чтобы ввести вывод команды bash](/docs/tui#bash-commands) в приглашение.
Например, чтобы создать пользовательскую команду, которая анализирует тестовое покрытие:
.opencode/commands/analyze-coverage.md```

---



description: Analyze test coverage



---


Here are the current test results:



!`npm test`



Based on these results, suggest improvements to increase coverage.

```

Или просмотреть последние изменения:
.opencode/commands/review-changes.md```

---



description: Review recent changes



---


Recent git commits:



!`git log --oneline -10`



Review these changes and suggest any improvements.

```

Команды выполняются в корневом каталоге вашего проекта, и их вывод становится частью приглашения.
* * *

### [Ссылки на файлы](https://opencode.ai/docs/commands#%D1%81%D1%81%D1%8B%D0%BB%D0%BA%D0%B8-%D0%BD%D0%B0-%D1%84%D0%B0%D0%B9%D0%BB%D1%8B)
Включите файлы в свою команду, используя `@`, за которым следует имя файла.
.opencode/commands/review-component.md```

---



description: Review component



---


Review the component in @src/components/Button.tsx.


Check for performance issues and suggest improvements.

```

Содержимое файла автоматически включается в приглашение.
* * *

