<!-- Source: https://opencode.ai/docs/ru/models -->

## [Установить значение по умолчанию](https://opencode.ai/docs/ru/models#%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%B8%D1%82%D1%8C-%D0%B7%D0%BD%D0%B0%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-%D0%BF%D0%BE-%D1%83%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D0%BD%D0%B8%D1%8E)
Чтобы установить одну из них в качестве модели по умолчанию, вы можете установить ключ `model` в вашем Конфигурация opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"model": "lmstudio/google/gemma-3n-e4b"



}

```

Здесь полный идентификатор `provider_id/model_id`. Например, если вы используете [OpenCode Zen](https://opencode.ai/docs/zen), вы должны использовать `opencode/gpt-5.1-codex` для кодекса GPT 5.1.
Если вы настроили [пользовательский поставщик](https://opencode.ai/docs/providers#custom), `provider_id` — это ключ из части `provider` вашей конфигурации, а `model_id` — это ключ из `provider.models`.
* * *

