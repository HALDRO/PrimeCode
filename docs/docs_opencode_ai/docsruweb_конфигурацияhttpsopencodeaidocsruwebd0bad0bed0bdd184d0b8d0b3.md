<!-- Source: https://opencode.ai/docs/ru/web -->

## [Конфигурация](https://opencode.ai/docs/ru/web#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
Вы можете настроить веб-сервер с помощью CLI-флагов или в файле [config file](https://opencode.ai/docs/config).

### [Порт](https://opencode.ai/docs/ru/web#%D0%BF%D0%BE%D1%80%D1%82)
По умолчанию opencode выбирает доступный порт. Вы можете указать порт:
Окно терминала```


opencodeweb--port4096


```

### [Имя хоста](https://opencode.ai/docs/ru/web#%D0%B8%D0%BC%D1%8F-%D1%85%D0%BE%D1%81%D1%82%D0%B0)
По умолчанию сервер привязывается к `127.0.0.1` (только локальный хост). Чтобы сделать opencode доступным в вашей сети:
Окно терминала```


opencodeweb--hostname0.0.0.0


```

При использовании `0.0.0.0` opencode будет отображать как локальные, так и сетевые адреса:
```

Local access:       http://localhost:4096


Network access:     http://192.168.1.100:4096

```

### [Обнаружение mDNS](https://opencode.ai/docs/ru/web#%D0%BE%D0%B1%D0%BD%D0%B0%D1%80%D1%83%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5-mdns)
Включите mDNS, чтобы ваш сервер был доступен для обнаружения в локальной сети:
Окно терминала```


opencodeweb--mdns


```

Это автоматически устанавливает имя хоста `0.0.0.0` и объявляет сервер как `opencode.local`.
Вы можете настроить доменное имя mDNS для запуска нескольких экземпляров в одной сети:
Окно терминала```


opencodeweb--mdns--mdns-domainmyproject.local


```

### [CORS](https://opencode.ai/docs/ru/web#cors)
Чтобы разрешить дополнительные домены для CORS (полезно для пользовательских интерфейсов):
Окно терминала```


opencodeweb--corshttps://example.com


```

### [Аутентификация](https://opencode.ai/docs/ru/web#%D0%B0%D1%83%D1%82%D0%B5%D0%BD%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
Чтобы защитить доступ, установите пароль, используя переменную среды `OPENCODE_SERVER_PASSWORD`:
Окно терминала```


OPENCODE_SERVER_PASSWORD=secretopencodeweb


```

Имя пользователя по умолчанию — `opencode`, но его можно изменить с помощью `OPENCODE_SERVER_USERNAME`.
* * *

