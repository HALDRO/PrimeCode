<!-- Source: https://opencode.ai/docs/sdk -->

## [Только клиент](https://opencode.ai/docs/sdk#%D1%82%D0%BE%D0%BB%D1%8C%D0%BA%D0%BE-%D0%BA%D0%BB%D0%B8%D0%B5%D0%BD%D1%82)
Если у вас уже есть работающий экземпляр opencode, вы можете создать экземпляр клиента для подключения к нему:
```


import { createOpencodeClient } from"@opencode-ai/sdk"




constclient=createOpencodeClient({




baseUrl: "http://localhost:4096",



})

```

#### [Параметры](https://opencode.ai/docs/sdk#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B-1)
Вариант | Тип | Описание | По умолчанию  
---|---|---|---  
`baseUrl` | `string` | URL of the server | `http://localhost:4096`  
`fetch` | `function` | Custom fetch implementation | `globalThis.fetch`  
`parseAs` | `string` | Response parsing method | `auto`  
`responseStyle` | `string` | Return style: `data` or `fields` | `fields`  
`throwOnError` | `boolean` | Throw errors instead of return | `false`  
* * *

