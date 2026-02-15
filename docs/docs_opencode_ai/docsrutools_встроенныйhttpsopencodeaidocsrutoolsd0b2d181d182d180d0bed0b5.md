<!-- Source: https://opencode.ai/docs/ru/tools -->

## [Встроенный](https://opencode.ai/docs/ru/tools#%D0%B2%D1%81%D1%82%D1%80%D0%BE%D0%B5%D0%BD%D0%BD%D1%8B%D0%B9)
Вот все встроенные инструменты, доступные в opencode.
* * *

### [bash](https://opencode.ai/docs/ru/tools#bash)
Выполняйте shell-команды в среде вашего проекта.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"bash": "allow"



}


}

```

Этот инструмент позволяет LLM запускать команды терминала, такие как `npm install`, `git status` или любую другую shell-команду.
* * *

### [edit](https://opencode.ai/docs/ru/tools#edit)
Измените существующие файлы, используя точную замену строк.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"edit": "allow"



}


}

```

Этот инструмент выполняет точное редактирование файлов, заменяя точные совпадения текста. Это основной способ изменения кода в LLM.
* * *

### [write](https://opencode.ai/docs/ru/tools#write)
Создавайте новые файлы или перезаписывайте существующие.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"edit": "allow"



}


}

```

Используйте это, чтобы позволить LLM создавать новые файлы. Он перезапишет существующие файлы, если они уже существуют.
Инструмент `write` контролируется разрешением `edit`, которое распространяется на все модификации файлов (`edit`, `write`, `patch`, `multiedit`).
* * *

### [read](https://opencode.ai/docs/ru/tools#read)
Прочитайте содержимое файла из вашей кодовой базы.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"read": "allow"



}


}

```

Этот инструмент читает файлы и возвращает их содержимое. Он поддерживает чтение определенных диапазонов строк для больших файлов.
* * *

### [grep](https://opencode.ai/docs/ru/tools#grep)
Поиск содержимого файла с помощью регулярных выражений.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"grep": "allow"



}


}

```

Быстрый поиск контента по вашей кодовой базе. Поддерживает полный синтаксис регулярных выражений и фильтрацию шаблонов файлов.
* * *

### [glob](https://opencode.ai/docs/ru/tools#glob)
Найдите файлы по шаблону.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"glob": "allow"



}


}

```

Ищите файлы, используя шаблоны glob, например `**/*.js` или `src/**/*.ts`. Возвращает соответствующие пути к файлам, отсортированные по времени изменения.
* * *

### [list](https://opencode.ai/docs/ru/tools#list)
Список файлов и каталогов по заданному пути.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"list": "allow"



}


}

```

Этот инструмент отображает содержимое каталога. Он принимает шаблоны glob для фильтрации результатов.
* * *

### [lsp (экспериментальный)](https://opencode.ai/docs/ru/tools#lsp-%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D1%80%D0%B8%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9)
Взаимодействуйте с настроенными серверами LSP, чтобы получить функции анализа кода, такие как определения, ссылки, информация о наведении и иерархия вызовов.
Этот инструмент доступен только при `OPENCODE_EXPERIMENTAL_LSP_TOOL=true` (или `OPENCODE_EXPERIMENTAL=true`).
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"lsp": "allow"



}


}

```

Поддерживаемые операции включают `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls` и `outgoingCalls`.
Чтобы настроить серверы LSP, доступные для вашего проекта, см. [LSP Servers](https://opencode.ai/docs/lsp).
* * *

### [patch](https://opencode.ai/docs/ru/tools#patch)
Применяйте патчи к файлам.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"edit": "allow"



}


}

```

Этот инструмент применяет файлы исправлений к вашей кодовой базе. Полезно для применения различий и патчей из различных источников.
Инструмент `patch` контролируется разрешением `edit`, которое распространяется на все модификации файлов (`edit`, `write`, `patch`, `multiedit`).
* * *

### [skill](https://opencode.ai/docs/ru/tools#skill)
Загрузите [skill](https://opencode.ai/docs/skills) (файл `SKILL.md`) и верните его содержимое в диалог.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"skill": "allow"



}


}

```

* * *

### [todowrite](https://opencode.ai/docs/ru/tools#todowrite)
Управляйте списками дел во время сеансов кодирования.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"todowrite": "allow"



}


}

```

Создает и обновляет списки задач для отслеживания прогресса во время сложных операций. LLM использует это для организации многоэтапных задач.
По умолчанию этот инструмент отключен для субагентов, но вы можете включить его вручную. [Подробнее](https://opencode.ai/docs/agents/#permissions)
* * *

### [todoread](https://opencode.ai/docs/ru/tools#todoread)
Прочтите существующие списки дел.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"todoread": "allow"



}


}

```

Считывает текущее состояние списка дел. Используется LLM для отслеживания задач, ожидающих или завершенных.
По умолчанию этот инструмент отключен для субагентов, но вы можете включить его вручную. [Подробнее](https://opencode.ai/docs/agents/#permissions)
* * *

### [webfetch](https://opencode.ai/docs/ru/tools#webfetch)
Получить веб-контент.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"webfetch": "allow"



}


}

```

Позволяет LLM получать и читать веб-страницы. Полезно для поиска документации или исследования онлайн-ресурсов.
* * *

### [websearch](https://opencode.ai/docs/ru/tools#websearch)
Найдите информацию в Интернете.
Этот инструмент доступен только при использовании поставщика opencode или когда для переменной среды `OPENCODE_ENABLE_EXA` установлено любое истинное значение (например, `true` или `1`).
Чтобы включить при запуске opencode:
Окно терминала```


OPENCODE_ENABLE_EXA=1opencode


```

opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"websearch": "allow"



}


}

```

Выполняет поиск в Интернете с помощью Exa AI для поиска соответствующей информации в Интернете. Полезно для исследования тем, поиска текущих событий или сбора информации, выходящей за рамки данных обучения.
Ключ API не требуется — инструмент подключается напрямую к сервису MCP, размещенному на Exa AI, без аутентификации.
Используйте `websearch`, когда вам нужно найти информацию (обнаружение), и `webfetch`, когда вам нужно получить контент с определенного URL-адреса (извлечение).
* * *

### [question](https://opencode.ai/docs/ru/tools#question)
Задавайте вопросы пользователю во время выполнения.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"question": "allow"



}


}

```

Этот инструмент позволяет LLM задавать вопросы пользователю во время выполнения задачи. Это полезно для:
  * Сбор предпочтений или требований пользователей
  * Уточнение двусмысленных инструкций
  * Получение решений по вариантам реализации
  * Предлагая выбор, в каком направлении двигаться


Каждый вопрос включает заголовок, текст вопроса и список вариантов. Пользователи могут выбрать один из предложенных вариантов или ввести собственный ответ. Если вопросов несколько, пользователи могут перемещаться между ними, прежде чем отправлять все ответы.
* * *

