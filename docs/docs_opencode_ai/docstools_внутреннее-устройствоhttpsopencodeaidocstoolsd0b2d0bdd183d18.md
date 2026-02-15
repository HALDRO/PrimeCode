<!-- Source: https://opencode.ai/docs/tools -->

## [Внутреннее устройство](https://opencode.ai/docs/tools#%D0%B2%D0%BD%D1%83%D1%82%D1%80%D0%B5%D0%BD%D0%BD%D0%B5%D0%B5-%D1%83%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE)
Внутренне такие инструменты, как `grep`, `glob` и `list`, используют [ripgrep](https://github.com/BurntSushi/ripgrep). По умолчанию ripgrep учитывает шаблоны `.gitignore`, что означает, что файлы и каталоги, перечисленные в вашем `.gitignore`, будут исключены из поиска и списков.
* * *

### [Игнорировать шаблоны](https://opencode.ai/docs/tools#%D0%B8%D0%B3%D0%BD%D0%BE%D1%80%D0%B8%D1%80%D0%BE%D0%B2%D0%B0%D1%82%D1%8C-%D1%88%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD%D1%8B)
Чтобы включить файлы, которые обычно игнорируются, создайте файл `.ignore` в корне вашего проекта. Этот файл может явно разрешать определенные пути.
.ignore```

!node_modules/


!dist/


!build/

```

Например, этот файл `.ignore` позволяет ripgrep выполнять поиск в каталогах `node_modules/`, `dist/` и `build/`, даже если они указаны в `.gitignore`.
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/tools.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

