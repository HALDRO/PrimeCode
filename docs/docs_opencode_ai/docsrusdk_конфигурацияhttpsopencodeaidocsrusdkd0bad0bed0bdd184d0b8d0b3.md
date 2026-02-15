<!-- Source: https://opencode.ai/docs/ru/sdk -->

## [Конфигурация](https://opencode.ai/docs/ru/sdk#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
Вы можете передать объект конфигурации для настройки поведения. Экземпляр по-прежнему получает ваш `opencode.json`, но вы можете переопределить или добавить встроенную конфигурацию:
```


import { createOpencode } from"@opencode-ai/sdk"




constopencode=awaitcreateOpencode({




hostname: "127.0.0.1",




port: 4096,



config: {



model: "anthropic/claude-3-5-sonnet-20241022",



},


})



console.log(`Server running at ${opencode.server.url}`)




opencode.server.close()


```

