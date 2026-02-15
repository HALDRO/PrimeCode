<!-- Source: https://opencode.ai/docs/ru/server -->

## На этой странице
  * [ Обзор ](https://opencode.ai/docs/ru/server#_top)
    * [ Использование ](https://opencode.ai/docs/ru/server#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5)
    * [ Аутентификация ](https://opencode.ai/docs/ru/server#%D0%B0%D1%83%D1%82%D0%B5%D0%BD%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
    * [ Как это работает ](https://opencode.ai/docs/ru/server#%D0%BA%D0%B0%D0%BA-%D1%8D%D1%82%D0%BE-%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0%D0%B5%D1%82)
  * [ Спецификация ](https://opencode.ai/docs/ru/server#%D1%81%D0%BF%D0%B5%D1%86%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
  * [ API ](https://opencode.ai/docs/ru/server#api)
    * [ Глобальный ](https://opencode.ai/docs/ru/server#%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9)
    * [ Проект ](https://opencode.ai/docs/ru/server#%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82)
    * [ Путь и система контроля версий ](https://opencode.ai/docs/ru/server#%D0%BF%D1%83%D1%82%D1%8C-%D0%B8-%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC%D0%B0-%D0%BA%D0%BE%D0%BD%D1%82%D1%80%D0%BE%D0%BB%D1%8F-%D0%B2%D0%B5%D1%80%D1%81%D0%B8%D0%B9)
    * [ Экземпляр ](https://opencode.ai/docs/ru/server#%D1%8D%D0%BA%D0%B7%D0%B5%D0%BC%D0%BF%D0%BB%D1%8F%D1%80)
    * [ Конфигурация ](https://opencode.ai/docs/ru/server#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
    * [ Поставщик ](https://opencode.ai/docs/ru/server#%D0%BF%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA)
    * [ Сессии ](https://opencode.ai/docs/ru/server#%D1%81%D0%B5%D1%81%D1%81%D0%B8%D0%B8)
    * [ Сообщения ](https://opencode.ai/docs/ru/server#%D1%81%D0%BE%D0%BE%D0%B1%D1%89%D0%B5%D0%BD%D0%B8%D1%8F)
    * [ Команды ](https://opencode.ai/docs/ru/server#%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D1%8B)
    * [ Файлы ](https://opencode.ai/docs/ru/server#%D1%84%D0%B0%D0%B9%D0%BB%D1%8B)
    * [ Инструменты (Экспериментальные) ](https://opencode.ai/docs/ru/server#%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B-%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D1%80%D0%B8%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5)
    * [ LSP, форматтеры и MCP ](https://opencode.ai/docs/ru/server#lsp-%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D1%82%D0%B5%D1%80%D1%8B-%D0%B8-mcp)
    * [ Агенты ](https://opencode.ai/docs/ru/server#%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B)
    * [ Ведение журнала ](https://opencode.ai/docs/ru/server#%D0%B2%D0%B5%D0%B4%D0%B5%D0%BD%D0%B8%D0%B5-%D0%B6%D1%83%D1%80%D0%BD%D0%B0%D0%BB%D0%B0)
    * [ TUI ](https://opencode.ai/docs/ru/server#tui)
    * [ Авторизация ](https://opencode.ai/docs/ru/server#%D0%B0%D0%B2%D1%82%D0%BE%D1%80%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D1%8F)
    * [ События ](https://opencode.ai/docs/ru/server#%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F)
    * [ Документы ](https://opencode.ai/docs/ru/server#%D0%B4%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B)

### [Использование](https://opencode.ai/docs/ru/server#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5)
Окно терминала```


opencodeserve [--port <number>] [--hostname <string>] [--cors <origin>]


```

#### [Параметры](https://opencode.ai/docs/ru/server#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B)
Флаг | Описание | По умолчанию  
---|---|---  
`--port` | Port to listen on | `4096`  
`--hostname` | Hostname to listen on | `127.0.0.1`  
`--mdns` | Enable mDNS discovery | `false`  
`--mdns-domain` | Custom domain name for mDNS service | `opencode.local`  
`--cors` | Additional browser origins to allow | `[]`  
`--cors` можно передать несколько раз:
Окно терминала```


opencodeserve--corshttp://localhost:5173--corshttps://app.example.com


```

* * *

### [Аутентификация](https://opencode.ai/docs/ru/server#%D0%B0%D1%83%D1%82%D0%B5%D0%BD%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
Установите `OPENCODE_SERVER_PASSWORD`, чтобы защитить сервер с помощью базовой аутентификации HTTP. Имя пользователя по умолчанию — `opencode` или установите `OPENCODE_SERVER_USERNAME`, чтобы переопределить его. Это относится как к `opencode serve`, так и к `opencode web`.
Окно терминала```


OPENCODE_SERVER_PASSWORD=your-passwordopencodeserve


```

* * *

### [Как это работает](https://opencode.ai/docs/ru/server#%D0%BA%D0%B0%D0%BA-%D1%8D%D1%82%D0%BE-%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0%D0%B5%D1%82)
Когда вы запускаете `opencode`, он запускает TUI и сервер. Где находится TUI клиент, который общается с сервером. Сервер предоставляет спецификацию OpenAPI 3.1. конечная точка. Эта конечная точка также используется для создания файла [SDK](https://opencode.ai/docs/sdk).
Используйте сервер opencode для программного взаимодействия с открытым кодом.
Эта архитектура позволяет открытому коду поддерживать несколько клиентов и позволяет программно взаимодействовать с открытым кодом.
Вы можете запустить `opencode serve`, чтобы запустить автономный сервер. Если у вас есть TUI с открытым кодом запущен, `opencode serve` запустит новый сервер.
* * *
#### [Подключиться к существующему серверу](https://opencode.ai/docs/ru/server#%D0%BF%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D1%8C%D1%81%D1%8F-%D0%BA-%D1%81%D1%83%D1%89%D0%B5%D1%81%D1%82%D0%B2%D1%83%D1%8E%D1%89%D0%B5%D0%BC%D1%83-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D1%83)
Когда вы запускаете TUI, он случайным образом назначает порт и имя хоста. Вместо этого вы можете передать `--hostname` и `--port` [flags](https://opencode.ai/docs/cli). Затем используйте это для подключения к его серверу.
Конечную точку [`/tui`](https://opencode.ai/docs/ru/server#tui) можно использовать для управления TUI через сервер. Например, вы можете предварительно заполнить или запустить подсказку. Эта настройка используется плагинами opencode [IDE](https://opencode.ai/docs/ide).
* * *

