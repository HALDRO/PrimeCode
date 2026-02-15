<!-- Source: https://opencode.ai/docs/plugins -->

## [Используйте плагин](https://opencode.ai/docs/plugins#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D1%83%D0%B9%D1%82%D0%B5-%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD)
Есть два способа загрузки плагинов.
* * *

### [Из локальных файлов](https://opencode.ai/docs/plugins#%D0%B8%D0%B7-%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D1%85-%D1%84%D0%B0%D0%B9%D0%BB%D0%BE%D0%B2)
Поместите файлы JavaScript или TypeScript в каталог плагина.
  * `.opencode/plugins/` – плагины уровня проекта.
  * `~/.config/opencode/plugins/` — глобальные плагины


Файлы в этих каталогах автоматически загружаются при запуске.
* * *

### [Из npm](https://opencode.ai/docs/plugins#%D0%B8%D0%B7-npm)
Укажите пакеты npm в файле конфигурации.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"plugin": ["opencode-helicone-session", "opencode-wakatime", "@my-org/custom-plugin"]



}

```

Поддерживаются как обычные, так и ограниченные пакеты npm.
Просмотрите доступные плагины в папке [ecosystem](https://opencode.ai/docs/ecosystem#plugins).
* * *

### [Как устанавливаются плагины](https://opencode.ai/docs/plugins#%D0%BA%D0%B0%D0%BA-%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%B0%D0%B2%D0%BB%D0%B8%D0%B2%D0%B0%D1%8E%D1%82%D1%81%D1%8F-%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD%D1%8B)
**Плагины npm** устанавливаются автоматически с помощью Bun при запуске. Пакеты и их зависимости кэшируются в `~/.cache/opencode/node_modules/`.
**Локальные плагины** загружаются непосредственно из каталога плагинов. Чтобы использовать внешние пакеты, вы должны создать `package.json` в своем каталоге конфигурации (см. [Зависимости](https://opencode.ai/docs/plugins#dependencies)) или опубликовать плагин в npm и [добавить его в свой config](https://opencode.ai/docs/config#plugins).
* * *

### [Порядок загрузки](https://opencode.ai/docs/plugins#%D0%BF%D0%BE%D1%80%D1%8F%D0%B4%D0%BE%D0%BA-%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B8)
Плагины загружаются из всех источников, и все хуки запускаются последовательно. Порядок загрузки следующий:
  1. Глобальная конфигурация (`~/.config/opencode/opencode.json`)
  2. Конфигурация проекта (`opencode.json`)
  3. Глобальный каталог плагинов (`~/.config/opencode/plugins/`)
  4. Каталог плагинов проекта (`.opencode/plugins/`)


Дубликаты пакетов npm с тем же именем и версией загружаются один раз. Однако локальный плагин и плагин npm со схожими именами загружаются отдельно.
* * *

