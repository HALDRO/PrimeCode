<!-- Source: https://opencode.ai/docs/formatters -->

## [Настройка](https://opencode.ai/docs/formatters#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете настроить форматтеры через раздел `formatter` в конфигурации opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"formatter": {}



}

```

Каждая конфигурация форматтера поддерживает следующее:
Свойство | Тип | Описание  
---|---|---  
`disabled` | boolean | Установите для этого параметра значение `true`, чтобы отключить форматтер.  
`command` | string[] | Команда для форматирования  
`environment` | объект | Переменные среды, которые необходимо установить при запуске средства форматирования  
`extensions` | string[] | Расширения файлов, которые должен обрабатывать этот форматтер  
Давайте посмотрим на несколько примеров.
* * *

### [Отключение форматтеров](https://opencode.ai/docs/formatters#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D1%82%D0%B5%D1%80%D0%BE%D0%B2)
Чтобы глобально отключить **все** средства форматирования, установите для `formatter` значение `false`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"formatter": false



}

```

Чтобы отключить **конкретный** форматтер, установите для `disabled` значение `true`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"formatter": {




"prettier": {




"disabled": true



}


}


}

```

* * *

### [Пользовательские форматтеры](https://opencode.ai/docs/formatters#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D1%82%D0%B5%D1%80%D1%8B)
Вы можете переопределить встроенные средства форматирования или добавить новые, указав команду, переменные среды и расширения файлов:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"formatter": {




"prettier": {




"command": ["npx", "prettier", "--write", "$FILE"],




"environment": {




"NODE_ENV": "development"



},



"extensions": [".js", ".ts", ".jsx", ".tsx"]



},



"custom-markdown-formatter": {




"command": ["deno", "fmt", "$FILE"],




"extensions": [".md"]



}


}


}

```

Заполнитель **`$FILE`**в команде будет заменен путем к форматируемому файлу.
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/formatters.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

