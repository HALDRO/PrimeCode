<!-- Source: https://opencode.ai/docs/ru/config -->

## [Переменные](https://opencode.ai/docs/ru/config#%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5)
Вы можете использовать подстановку переменных в файлах конфигурации для ссылки на переменные среды и содержимое файлов.
* * *

### [Переменные окружения](https://opencode.ai/docs/ru/config#%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5-%D0%BE%D0%BA%D1%80%D1%83%D0%B6%D0%B5%D0%BD%D0%B8%D1%8F)
Используйте `{env:VARIABLE_NAME}` для замены переменных среды:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"model": "{env:OPENCODE_MODEL}",




"provider": {




"anthropic": {




"models": {},




"options": {




"apiKey": "{env:ANTHROPIC_API_KEY}"



}


}


}


}

```

Если переменная среды не установлена, она будет заменена пустой строкой.
* * *

### [Файлы](https://opencode.ai/docs/ru/config#%D1%84%D0%B0%D0%B9%D0%BB%D1%8B)
Используйте `{file:path/to/file}` для замены содержимого файла:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"instructions": ["./custom-instructions.md"],




"provider": {




"openai": {




"options": {




"apiKey": "{file:~/.secrets/openai-key}"



}


}


}


}

```

Пути к файлам могут быть:
  * Относительно каталога файла конфигурации
  * Или абсолютные пути, начинающиеся с `/` или `~`.


Они полезны для:
  * Хранение конфиденциальных данных, таких как ключи API, в отдельных файлах.
  * Включая большие файлы инструкций, не загромождая вашу конфигурацию.
  * Совместное использование общих фрагментов конфигурации в нескольких файлах конфигурации.


[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/config.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

