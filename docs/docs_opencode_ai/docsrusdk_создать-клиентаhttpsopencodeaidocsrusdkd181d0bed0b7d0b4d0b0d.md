<!-- Source: https://opencode.ai/docs/ru/sdk -->

## [Создать клиента](https://opencode.ai/docs/ru/sdk#%D1%81%D0%BE%D0%B7%D0%B4%D0%B0%D1%82%D1%8C-%D0%BA%D0%BB%D0%B8%D0%B5%D0%BD%D1%82%D0%B0)
Создайте экземпляр opencode:
```


import { createOpencode } from"@opencode-ai/sdk"




const { client } =awaitcreateOpencode()


```

Это запускает и сервер, и клиент.
#### [Параметры](https://opencode.ai/docs/ru/sdk#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B)
Вариант | Тип | Описание | По умолчанию  
---|---|---|---  
`hostname` | `string` | Server hostname | `127.0.0.1`  
`port` | `number` | Server port | `4096`  
`signal` | `AbortSignal` | Abort signal for cancellation | `undefined`  
`timeout` | `number` | Timeout in ms for server start | `5000`  
`config` | `Config` | Configuration object | `{}`  
* * *

