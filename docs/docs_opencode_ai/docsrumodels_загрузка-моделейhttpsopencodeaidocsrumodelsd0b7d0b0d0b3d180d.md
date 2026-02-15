<!-- Source: https://opencode.ai/docs/ru/models -->

## [Загрузка моделей](https://opencode.ai/docs/ru/models#%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B0-%D0%BC%D0%BE%D0%B4%D0%B5%D0%BB%D0%B5%D0%B9)
Когда opencode запускается, он проверяет модели в следующем порядке приоритета:
  1. CLI-флаг `--model` или `-m`. Формат тот же, что и в файле конфигурации: `provider_id/model_id`.
  2. Список моделей в конфигурации opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"model": "anthropic/claude-sonnet-4-20250514"



}

```

Здесь используется формат `provider/model`.
  3. Последняя использованная модель.
  4. Первая модель, использующая внутренний приоритет.


[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/models.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

