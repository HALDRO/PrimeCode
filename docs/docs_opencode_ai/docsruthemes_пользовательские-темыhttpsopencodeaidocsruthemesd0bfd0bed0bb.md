<!-- Source: https://opencode.ai/docs/ru/themes -->

## [Пользовательские темы](https://opencode.ai/docs/ru/themes#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-%D1%82%D0%B5%D0%BC%D1%8B)
opencode поддерживает гибкую систему тем на основе JSON, которая позволяет пользователям легко создавать и настраивать темы.
* * *

### [Иерархия](https://opencode.ai/docs/ru/themes#%D0%B8%D0%B5%D1%80%D0%B0%D1%80%D1%85%D0%B8%D1%8F)
Темы загружаются из нескольких каталогов в следующем порядке: более поздние каталоги переопределяют предыдущие:
  1. **Встроенные темы** – они встроены в двоичный файл.
  2. **Каталог конфигурации пользователя** – определяется в `~/.config/opencode/themes/*.json` или `$XDG_CONFIG_HOME/opencode/themes/*.json`.
  3. **Корневой каталог проекта** – определено в `<project-root>/.opencode/themes/*.json`.
  4. **Текущий рабочий каталог** – определено в `./.opencode/themes/*.json`.


Если несколько каталогов содержат тему с одинаковым именем, будет использоваться тема из каталога с более высоким приоритетом.
* * *

### [Создание темы](https://opencode.ai/docs/ru/themes#%D1%81%D0%BE%D0%B7%D0%B4%D0%B0%D0%BD%D0%B8%D0%B5-%D1%82%D0%B5%D0%BC%D1%8B)
Чтобы создать собственную тему, создайте файл JSON в одном из каталогов темы.
Для глобальных тем:
Окно терминала```


mkdir-p~/.config/opencode/themes




vim~/.config/opencode/themes/my-theme.json


```

Для тем проекта:
Окно терминала```


mkdir-p.opencode/themes




vim.opencode/themes/my-theme.json


```

* * *

### [Формат JSON](https://opencode.ai/docs/ru/themes#%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82-json)
В темах используется гибкий формат JSON с поддержкой:
  * **Шестнадцатеричные цвета** : `"#ffffff"`
  * **Цвета ANSI** : `3` (0–255).
  * **Ссылки на цвета** : `"primary"` или пользовательские определения.
  * **Темный/светлый варианты** : `{"dark": "#000", "light": "#fff"}`
  * **Нет цвета** : `"none"` — используется цвет терминала по умолчанию или прозрачный.


* * *

### [Определения цвета](https://opencode.ai/docs/ru/themes#%D0%BE%D0%BF%D1%80%D0%B5%D0%B4%D0%B5%D0%BB%D0%B5%D0%BD%D0%B8%D1%8F-%D1%86%D0%B2%D0%B5%D1%82%D0%B0)
Раздел `defs` является необязательным и позволяет вам определять повторно используемые цвета, на которые можно ссылаться в теме.
* * *

### [Настройки терминала по умолчанию](https://opencode.ai/docs/ru/themes#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B8-%D1%82%D0%B5%D1%80%D0%BC%D0%B8%D0%BD%D0%B0%D0%BB%D0%B0-%D0%BF%D0%BE-%D1%83%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D0%BD%D0%B8%D1%8E)
Специальное значение `"none"` можно использовать для любого цвета, чтобы наследовать цвет терминала по умолчанию. Это особенно полезно для создания тем, которые органично сочетаются с цветовой схемой вашего терминала:
  * `"text": "none"` — использует цвет переднего плана терминала по умолчанию.
  * `"background": "none"` — использует цвет фона терминала по умолчанию.


* * *

### [Пример](https://opencode.ai/docs/ru/themes#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80)
Вот пример пользовательской темы:
my-theme.json```

{



"$schema": "https://opencode.ai/theme.json",




"defs": {




"nord0": "#2E3440",




"nord1": "#3B4252",




"nord2": "#434C5E",




"nord3": "#4C566A",




"nord4": "#D8DEE9",




"nord5": "#E5E9F0",




"nord6": "#ECEFF4",




"nord7": "#8FBCBB",




"nord8": "#88C0D0",




"nord9": "#81A1C1",




"nord10": "#5E81AC",




"nord11": "#BF616A",




"nord12": "#D08770",




"nord13": "#EBCB8B",




"nord14": "#A3BE8C",




"nord15": "#B48EAD"



},



"theme": {




"primary": {




"dark": "nord8",




"light": "nord10"



},



"secondary": {




"dark": "nord9",




"light": "nord9"



},



"accent": {




"dark": "nord7",




"light": "nord7"



},



"error": {




"dark": "nord11",




"light": "nord11"



},



"warning": {




"dark": "nord12",




"light": "nord12"



},



"success": {




"dark": "nord14",




"light": "nord14"



},



"info": {




"dark": "nord8",




"light": "nord10"



},



"text": {




"dark": "nord4",




"light": "nord0"



},



"textMuted": {




"dark": "nord3",




"light": "nord1"



},



"background": {




"dark": "nord0",




"light": "nord6"



},



"backgroundPanel": {




"dark": "nord1",




"light": "nord5"



},



"backgroundElement": {




"dark": "nord1",




"light": "nord4"



},



"border": {




"dark": "nord2",




"light": "nord3"



},



"borderActive": {




"dark": "nord3",




"light": "nord2"



},



"borderSubtle": {




"dark": "nord2",




"light": "nord3"



},



"diffAdded": {




"dark": "nord14",




"light": "nord14"



},



"diffRemoved": {




"dark": "nord11",




"light": "nord11"



},



"diffContext": {




"dark": "nord3",




"light": "nord3"



},



"diffHunkHeader": {




"dark": "nord3",




"light": "nord3"



},



"diffHighlightAdded": {




"dark": "nord14",




"light": "nord14"



},



"diffHighlightRemoved": {




"dark": "nord11",




"light": "nord11"



},



"diffAddedBg": {




"dark": "#3B4252",




"light": "#E5E9F0"



},



"diffRemovedBg": {




"dark": "#3B4252",




"light": "#E5E9F0"



},



"diffContextBg": {




"dark": "nord1",




"light": "nord5"



},



"diffLineNumber": {




"dark": "nord2",




"light": "nord4"



},



"diffAddedLineNumberBg": {




"dark": "#3B4252",




"light": "#E5E9F0"



},



"diffRemovedLineNumberBg": {




"dark": "#3B4252",




"light": "#E5E9F0"



},



"markdownText": {




"dark": "nord4",




"light": "nord0"



},



"markdownHeading": {




"dark": "nord8",




"light": "nord10"



},



"markdownLink": {




"dark": "nord9",




"light": "nord9"



},



"markdownLinkText": {




"dark": "nord7",




"light": "nord7"



},



"markdownCode": {




"dark": "nord14",




"light": "nord14"



},



"markdownBlockQuote": {




"dark": "nord3",




"light": "nord3"



},



"markdownEmph": {




"dark": "nord12",




"light": "nord12"



},



"markdownStrong": {




"dark": "nord13",




"light": "nord13"



},



"markdownHorizontalRule": {




"dark": "nord3",




"light": "nord3"



},



"markdownListItem": {




"dark": "nord8",




"light": "nord10"



},



"markdownListEnumeration": {




"dark": "nord7",




"light": "nord7"



},



"markdownImage": {




"dark": "nord9",




"light": "nord9"



},



"markdownImageText": {




"dark": "nord7",




"light": "nord7"



},



"markdownCodeBlock": {




"dark": "nord4",




"light": "nord0"



},



"syntaxComment": {




"dark": "nord3",




"light": "nord3"



},



"syntaxKeyword": {




"dark": "nord9",




"light": "nord9"



},



"syntaxFunction": {




"dark": "nord8",




"light": "nord8"



},



"syntaxVariable": {




"dark": "nord7",




"light": "nord7"



},



"syntaxString": {




"dark": "nord14",




"light": "nord14"



},



"syntaxNumber": {




"dark": "nord15",




"light": "nord15"



},



"syntaxType": {




"dark": "nord7",




"light": "nord7"



},



"syntaxOperator": {




"dark": "nord9",




"light": "nord9"



},



"syntaxPunctuation": {




"dark": "nord4",




"light": "nord0"



}


}


}

```

[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/themes.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

