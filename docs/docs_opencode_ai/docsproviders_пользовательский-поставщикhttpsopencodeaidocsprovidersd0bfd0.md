<!-- Source: https://opencode.ai/docs/providers -->

## [Пользовательский поставщик](https://opencode.ai/docs/providers#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B9-%D0%BF%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA)
Чтобы добавить любого **совместимого с OpenAI** поставщика, не указанного в команде `/connect`:
Вы можете использовать любого OpenAI-совместимого провайдера с открытым кодом. Большинство современных поставщиков ИИ предлагают API-интерфейсы, совместимые с OpenAI.
  1. Запустите команду `/connect` и прокрутите вниз до пункта **Другое**.
Окно терминала```


$/connect




┌Addcredential



│



◆Selectprovider




│...




│●Other



└

```

  2. Введите уникальный идентификатор провайдера.
Окно терминала```


$/connect




┌Addcredential



│



◇Enterproviderid




│myprovider



└

```

:::примечание Выберите запоминающийся идентификатор, вы будете использовать его в своем файле конфигурации. :::
  3. Введите свой ключ API для провайдера.
Окно терминала```


$/connect




┌Addcredential



│



▲Thisonlystoresacredentialformyprovider-youwillneedtoconfigureitinopencode.json,checkthedocsforexamples.



│



◇EnteryourAPIkey




│sk-...



└

```

  4. Создайте или обновите файл `opencode.json` в каталоге вашего проекта:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"myprovider": {




"npm": "@ai-sdk/openai-compatible",




"name": "My AI ProviderDisplay Name",




"options": {




"baseURL": "https://api.myprovider.com/v1"



},



"models": {




"my-model-name": {




"name": "My Model Display Name"



}


}


}


}


}

```

Вот варианты конфигурации:
     * **npm** : используемый пакет AI SDK, `@ai-sdk/openai-compatible` для поставщиков, совместимых с OpenAI.
     * **имя** : отображаемое имя в пользовательском интерфейсе.
     * **модели** : Доступные модели.
     * **options.baseURL** : URL-адрес конечной точки API.
     * **options.apiKey** : при необходимости установите ключ API, если не используется аутентификация.
     * **options.headers** : при необходимости можно установить собственные заголовки.
Подробнее о дополнительных параметрах в примере ниже.
  5. Запустите команду `/models`, и ваш пользовательский поставщик и модели появятся в списке выбора.


* * *
##### [Пример](https://opencode.ai/docs/providers#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80)
Ниже приведен пример настройки параметров `apiKey`, `headers` и модели `limit`.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"myprovider": {




"npm": "@ai-sdk/openai-compatible",




"name": "My AI ProviderDisplay Name",




"options": {




"baseURL": "https://api.myprovider.com/v1",




"apiKey": "{env:ANTHROPIC_API_KEY}",




"headers": {




"Authorization": "Bearer custom-token"



}


},



"models": {




"my-model-name": {




"name": "My Model Display Name",




"limit": {




"context": 200000,




"output": 65536



}


}


}


}


}


}

```

Детали конфигурации:
  * **apiKey** : устанавливается с использованием синтаксиса переменной `env`, [подробнее ](https://opencode.ai/docs/config#env-vars).
  * **заголовки** : пользовательские заголовки, отправляемые с каждым запросом.
  * **limit.context** : Максимальное количество входных токенов, которые принимает модель.
  * **limit.output** : Максимальное количество токенов, которые может сгенерировать модель.


Поля `limit` позволяют opencode понять, сколько контекста у вас осталось. Стандартные поставщики автоматически извлекают их из models.dev.
* * *

