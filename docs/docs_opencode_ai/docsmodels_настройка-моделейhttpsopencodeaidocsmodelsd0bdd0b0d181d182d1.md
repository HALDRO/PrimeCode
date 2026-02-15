<!-- Source: https://opencode.ai/docs/models -->

## [Настройка моделей](https://opencode.ai/docs/models#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0-%D0%BC%D0%BE%D0%B4%D0%B5%D0%BB%D0%B5%D0%B9)
Вы можете глобально настроить параметры модели через файл config.
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"openai": {




"models": {




"gpt-5": {




"options": {




"reasoningEffort": "high",




"textVerbosity": "low",




"reasoningSummary": "auto",




"include": ["reasoning.encrypted_content"],



},


},


},


},



"anthropic": {




"models": {




"claude-sonnet-4-5-20250929": {




"options": {




"thinking": {




"type": "enabled",




"budgetTokens": 16000,



},


},


},


},


},


},


}

```

Здесь мы настраиваем глобальные параметры для двух встроенных моделей: `gpt-5` при доступе через поставщика `openai` и `claude-sonnet-4-20250514` при доступе через поставщика `anthropic`. Названия встроенных поставщиков и моделей можно найти на сайте [Models.dev](https://models.dev).
Вы также можете настроить эти параметры для любых используемых вами агентов. Конфигурация агента переопределяет любые глобальные параметры здесь. [Подробнее](https://opencode.ai/docs/agents/#additional).
Вы также можете определить собственные варианты, расширяющие встроенные. Варианты позволяют настраивать разные параметры для одной и той же модели без создания повторяющихся записей:
opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"opencode": {




"models": {




"gpt-5": {




"variants": {




"high": {




"reasoningEffort": "high",




"textVerbosity": "low",




"reasoningSummary": "auto",



},



"low": {




"reasoningEffort": "low",




"textVerbosity": "low",




"reasoningSummary": "auto",



},


},


},


},


},


},


}

```

* * *

