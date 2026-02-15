<!-- Source: https://opencode.ai/docs/cli -->

## [Команды](https://opencode.ai/docs/cli#%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D1%8B)
CLI opencode также имеет следующие команды.
* * *

### [agent](https://opencode.ai/docs/cli#agent)
Управляйте агентами для opencode.
Окно терминала```


opencodeagent [command]


```

* * *

### [attach](https://opencode.ai/docs/cli#attach)
Подключите терминал к уже работающему внутреннему серверу opencode, запущенному с помощью команд `serve` или `web`.
Окно терминала```


opencodeattach [url]


```

Это позволяет использовать TUI с удаленным сервером opencode. Например:
Окно терминала```

### [auth](https://opencode.ai/docs/cli#auth)
Команда для управления учетными данными и входом в систему для провайдеров.
Окно терминала```


opencodeauth [command]


```

* * *
#### [login](https://opencode.ai/docs/cli#login)
opencode использует список провайдеров с [Models.dev](https://models.dev), поэтому вы можете использовать `opencode auth login` для настройки ключей API для любого поставщика, которого вы хотите использовать. Это хранится в `~/.local/share/opencode/auth.json`.
Окно терминала```


opencodeauthlogin


```

Когда opencode запускается, он загружает поставщиков из файла учетных данных. И если в ваших средах определены какие-либо ключи или файл `.env` в вашем проекте.
* * *
#### [list](https://opencode.ai/docs/cli#list-1)
Перечисляет всех проверенных поставщиков, которые хранятся в файле учетных данных.
Окно терминала```


opencodeauthlist


```

Или короткая версия.
Окно терминала```


opencodeauthls


```

* * *
#### [logout](https://opencode.ai/docs/cli#logout)
Выключает вас из провайдера, удаляя его из файла учетных данных.
Окно терминала```


opencodeauthlogout


```

* * *

### [github](https://opencode.ai/docs/cli#github)
Управляйте агентом GitHub для автоматизации репозитория.
Окно терминала```


opencodegithub [command]


```

* * *
#### [install](https://opencode.ai/docs/cli#install)
Установите агент GitHub в свой репозиторий.
Окно терминала```


opencodegithubinstall


```

Это настроит необходимый рабочий процесс GitHub Actions и проведет вас через процесс настройки. [Подробнее](https://opencode.ai/docs/github).
* * *
#### [run](https://opencode.ai/docs/cli#run)
Запустите агент GitHub. Обычно это используется в действиях GitHub.
Окно терминала```


opencodegithubrun


```

##### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-2)
Флаг | Описание  
---|---  
`--event` | Имитирующее событие GitHub для запуска агента  
`--token` | Токен личного доступа GitHub  
* * *

### [mcp](https://opencode.ai/docs/cli#mcp)
Управляйте серверами протокола контекста модели.
Окно терминала```


opencodemcp [command]


```

* * *
#### [add](https://opencode.ai/docs/cli#add)
Добавьте сервер MCP в свою конфигурацию.
Окно терминала```


opencodemcpadd


```

Эта команда поможет вам добавить локальный или удаленный сервер MCP.
* * *
#### [list](https://opencode.ai/docs/cli#list-2)
Перечислите все настроенные серверы MCP и состояние их подключения.
Окно терминала```


opencodemcplist


```

Или используйте короткую версию.
Окно терминала```


opencodemcpls


```

* * *
#### [auth](https://opencode.ai/docs/cli#auth-1)
Аутентификация с помощью сервера MCP с поддержкой OAuth.
Окно терминала```


opencodemcpauth [name]


```

Если вы не укажете имя сервера, вам будет предложено выбрать один из доступных серверов с поддержкой OAuth.
Вы также можете перечислить серверы с поддержкой OAuth и их статус аутентификации.
Окно терминала```


opencodemcpauthlist


```

Или используйте короткую версию.
Окно терминала```


opencodemcpauthls


```

* * *
#### [logout](https://opencode.ai/docs/cli#logout-1)
Удалите учетные данные OAuth для сервера MCP.
Окно терминала```


opencodemcplogout [name]


```

* * *
#### [debug](https://opencode.ai/docs/cli#debug)
Отладка проблем с подключением OAuth для сервера MCP.
Окно терминала```


opencodemcpdebug<name>


```

* * *

### [models](https://opencode.ai/docs/cli#models)
Перечислите все доступные модели от настроенных поставщиков.
Окно терминала```


opencodemodels [provider]


```

Эта команда отображает все модели, доступные у настроенных вами поставщиков, в формате `provider/model`.
Это полезно для определения точного названия модели, которое будет использоваться в [вашем config](https://opencode.ai/docs/config/).
При желании вы можете передать идентификатор поставщика, чтобы фильтровать модели по этому поставщику.
Окно терминала```


opencodemodelsanthropic


```

#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-3)
Флаг | Описание  
---|---  
`--refresh` | Обновите кеш моделей на сайте models.dev.  
`--verbose` | Используйте более подробный вывод модели (включая метаданные, такие как затраты).  
Используйте флаг `--refresh` для обновления списка кэшированных моделей. Это полезно, когда к поставщику добавлены новые модели и вы хотите увидеть их в opencode.
Окно терминала```


opencodemodels--refresh


```

* * *

### [run](https://opencode.ai/docs/cli#run-1)
Запустите opencode в неинтерактивном режиме, передав приглашение напрямую.
Окно терминала```


opencoderun [message..]


```

Это полезно для создания сценариев, автоматизации или когда вам нужен быстрый ответ без запуска полного TUI. Например.
Окно терминала```


opencoderunExplaintheuseofcontextinGo


```

Вы также можете подключиться к работающему экземпляру `opencode serve`, чтобы избежать холодной загрузки сервера MCP при каждом запуске:
Окно терминала```

### [serve](https://opencode.ai/docs/cli#serve)
Запустите автономный сервер opencode для доступа к API. Полный HTTP-интерфейс можно найти в [server docs](https://opencode.ai/docs/server).
Окно терминала```


opencodeserve


```

При этом запускается HTTP-сервер, который обеспечивает доступ API к функциям opencode без интерфейса TUI. Установите `OPENCODE_SERVER_PASSWORD`, чтобы включить базовую аутентификацию HTTP (имя пользователя по умолчанию — `opencode`).
#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-5)
Флаг | Описание  
---|---  
`--port` | Порт для прослушивания  
`--hostname` | Имя хоста для прослушивания  
`--mdns` | Включить обнаружение mDNS  
`--cors` | Дополнительные источники браузера, позволяющие разрешить CORS  
* * *

### [session](https://opencode.ai/docs/cli#session)
Управляйте сессиями opencode.
Окно терминала```


opencodesession [command]


```

* * *
#### [list](https://opencode.ai/docs/cli#list-3)
Перечислите все сеансы opencode.
Окно терминала```


opencodesessionlist


```

##### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-6)
Флаг | Короткий | Описание  
---|---|---  
`--max-count` | `-n` | Ограничить N последних сеансов.  
`--format` |  | Формат вывода: таблица или json (таблица)  
* * *

### [stats](https://opencode.ai/docs/cli#stats)
Покажите статистику использования токенов и затрат для ваших сеансов opencode.
Окно терминала```


opencodestats


```

#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-7)
Флаг | Описание  
---|---  
`--days` | Показать статистику за последние N дней (все время)  
`--tools` | Количество инструментов для отображения (все)  
`--models` | Показать разбивку по использованию модели (по умолчанию скрыто). Передайте номер, чтобы показать верхнюю N  
`--project` | Фильтровать по проекту (все проекты, пустая строка: текущий проект)  
* * *

### [export](https://opencode.ai/docs/cli#export)
Экспортируйте данные сеанса в формате JSON.
Окно терминала```


opencodeexport [sessionID]


```

Если вы не укажете идентификатор сеанса, вам будет предложено выбрать один из доступных сеансов.
* * *

### [import](https://opencode.ai/docs/cli#import)
Импортируйте данные сеанса из файла JSON или URL-адреса общего ресурса opencode.
Окно терминала```


opencodeimport<file>


```

Вы можете импортировать из локального файла или URL-адреса общего ресурса opencode.
Окно терминала```


opencodeimportsession.json




opencodeimporthttps://opncd.ai/s/abc123


```

* * *

### [web](https://opencode.ai/docs/cli#web)
Запустите автономный сервер opencode с веб-интерфейсом.
Окно терминала```


opencodeweb


```

При этом запускается HTTP-сервер и открывается веб-браузер для доступа к opencode через веб-интерфейс. Установите `OPENCODE_SERVER_PASSWORD`, чтобы включить базовую аутентификацию HTTP (имя пользователя по умолчанию — `opencode`).
#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-8)
Флаг | Описание  
---|---  
`--port` | Порт для прослушивания  
`--hostname` | Имя хоста для прослушивания  
`--mdns` | Включить обнаружение mDNS  
`--cors` | Дополнительные источники браузера, позволяющие разрешить CORS  
* * *

### [acp](https://opencode.ai/docs/cli#acp)
Запустите сервер ACP (агент-клиентский протокол).
Окно терминала```


opencodeacp


```

Эта команда запускает сервер ACP, который обменивается данными через stdin/stdout с использованием nd-JSON.
#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-9)
Флаг | Описание  
---|---  
`--cwd` | Рабочий каталог  
`--port` | Порт для прослушивания  
`--hostname` | Имя хоста для прослушивания  
* * *

### [uninstall](https://opencode.ai/docs/cli#uninstall)
Удалите opencode и удалите все связанные файлы.
Окно терминала```


opencodeuninstall


```

#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-10)
Флаг | Короткий | Описание  
---|---|---  
`--keep-config` | `-c` | Сохраняйте файлы конфигурации  
`--keep-data` | `-d` | Храните данные сеанса и снимки  
`--dry-run` |  | Покажите, что было бы удалено без удаления  
`--force` | `-f` | Пропустить запросы подтверждения  
* * *

### [upgrade](https://opencode.ai/docs/cli#upgrade)
Обновляет opencode до последней версии или определенной версии.
Окно терминала```


opencodeupgrade [target]


```

Чтобы обновиться до последней версии.
Окно терминала```


opencodeupgrade


```

Для обновления до определенной версии.
Окно терминала```


opencodeupgradev0.1.48


```

#### [Флаги](https://opencode.ai/docs/cli#%D1%84%D0%BB%D0%B0%D0%B3%D0%B8-11)
Флаг | Короткий | Описание  
---|---|---  
`--method` | `-m` | Используемый метод установки: local, npm, pnpm, bun, brew  
* * *

