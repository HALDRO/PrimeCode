<!-- Source: https://opencode.ai/docs/ru/providers -->

## [Поиск неисправностей](https://opencode.ai/docs/ru/providers#%D0%BF%D0%BE%D0%B8%D1%81%D0%BA-%D0%BD%D0%B5%D0%B8%D1%81%D0%BF%D1%80%D0%B0%D0%B2%D0%BD%D0%BE%D1%81%D1%82%D0%B5%D0%B9)
Если у вас возникли проблемы с настройкой провайдера, проверьте следующее:
  1. **Проверьте настройку аутентификации** : запустите `opencode auth list`, чтобы проверить, верны ли учетные данные. для провайдера добавлены в ваш конфиг.
Это не относится к таким поставщикам, как Amazon Bedrock, которые для аутентификации полагаются на переменные среды.
  2. Для пользовательских поставщиков проверьте конфигурацию opencode и:
     * Убедитесь, что идентификатор провайдера, используемый в команде `/connect`, соответствует идентификатору в вашей конфигурации opencode.
     * Для провайдера используется правильный пакет npm. Например, используйте `@ai-sdk/cerebras` для Cerebras. А для всех других поставщиков, совместимых с OpenAI, используйте `@ai-sdk/openai-compatible`.
     * Убедитесь, что в поле `options.baseURL` используется правильная конечная точка API.


[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/providers.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

