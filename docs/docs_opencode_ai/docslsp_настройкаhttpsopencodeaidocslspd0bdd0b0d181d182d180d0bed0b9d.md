<!-- Source: https://opencode.ai/docs/lsp -->

## [Настройка](https://opencode.ai/docs/lsp#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете настроить серверы LSP через раздел `lsp` в конфигурации opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"lsp": {}



}

```

Каждый LSP-сервер поддерживает следующее:
Свойство | Тип | Описание  
---|---|---  
`disabled` | boolean | Установите для этого параметра значение `true`, чтобы отключить сервер LSP.  
`command` | string[] | Команда запуска LSP-сервера  
`extensions` | string[] | Расширения файлов, которые должен обрабатывать этот сервер LSP  
`env` | object | Переменные среды, которые нужно установить при запуске сервера  
`initialization` | object | Параметры инициализации для отправки на сервер LSP  
Давайте посмотрим на несколько примеров.
* * *

### [Переменные среды](https://opencode.ai/docs/lsp#%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%8B)
Используйте свойство `env` для установки переменных среды при запуске сервера LSP:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"lsp": {




"rust": {




"env": {




"RUST_LOG": "debug"



}


}


}


}

```

* * *

### [Параметры инициализации](https://opencode.ai/docs/lsp#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B-%D0%B8%D0%BD%D0%B8%D1%86%D0%B8%D0%B0%D0%BB%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D0%B8)
Используйте свойство `initialization` для передачи параметров инициализации на LSP-сервер. Это настройки, специфичные для сервера, отправляемые во время запроса LSP `initialize`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"lsp": {




"typescript": {




"initialization": {




"preferences": {




"importModuleSpecifierPreference": "relative"



}


}


}


}


}

```

Параметры инициализации зависят от сервера LSP. Проверьте документацию вашего LSP-сервера на наличие доступных опций.
* * *

### [Отключение LSP-серверов](https://opencode.ai/docs/lsp#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-lsp-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D0%BE%D0%B2)
Чтобы отключить **все** LSP-серверы глобально, установите для `lsp` значение `false`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"lsp": false



}

```

Чтобы отключить **конкретный** LSP-сервер, установите для `disabled` значение `true`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"lsp": {




"typescript": {




"disabled": true



}


}


}

```

* * *

### [Пользовательские LSP-серверы](https://opencode.ai/docs/lsp#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-lsp-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D1%8B)
Вы можете добавить собственные LSP-серверы, указав команду и расширения файлов:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"lsp": {




"custom-lsp": {




"command": ["custom-lsp-server", "--stdio"],




"extensions": [".custom"]



}


}


}

```

* * *

