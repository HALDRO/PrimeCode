<!-- Source: https://opencode.ai/docs/github -->

## [Примеры](https://opencode.ai/docs/github#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B)
Вот несколько примеров того, как вы можете использовать opencode в GitHub.
  * **Объяснение проблемы**
Добавьте этот комментарий в выпуск GitHub.
```

/opencode explain this issue

```

opencode прочитает всю ветку, включая все комментарии, и ответит с четким объяснением.
  * **Исправление проблемы**
В выпуске GitHub скажите:
```

/opencode fix this

```

А opencode создаст новую ветку, внедрит изменения и откроет PR с изменениями.
  * **Проверка Pull Request и внесение изменений**
Оставьте следующий комментарий к PR на GitHub.
```

Delete the attachment from S3 when the note is removed /oc

```

opencode внедрит запрошенное изменение и зафиксирует его в том же PR.
  * **Проверка отдельных строк кода**
Оставляйте комментарии непосредственно к строкам кода на вкладке «Файлы» PR. opencode автоматически определяет файл, номера строк и контекст различий, чтобы предоставить точные ответы.
```

[Comment on specific lines in Files tab]


/oc add error handling here

```

При комментировании определенных строк opencode получает:
    * Точный файл, который просматривается
    * Конкретные строки кода
    * Окружающий контекст различий
    * Информация о номере строки
Это позволяет выполнять более целевые запросы без необходимости вручную указывать пути к файлам или номера строк.


[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/github.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

