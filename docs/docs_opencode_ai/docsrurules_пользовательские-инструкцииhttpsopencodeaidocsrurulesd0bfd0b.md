<!-- Source: https://opencode.ai/docs/ru/rules -->

## [Пользовательские инструкции](https://opencode.ai/docs/ru/rules#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%86%D0%B8%D0%B8)
Вы можете указать собственные файлы инструкций в `opencode.json` или в глобальном `~/.config/opencode/opencode.json`. Это позволит вам и вашей команде повторно использовать существующие правила вместо того, чтобы дублировать их на AGENTS.md.
Пример:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"]



}

```

Вы также можете использовать удаленные URL-адреса для загрузки инструкций из Интернета.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"instructions": ["https://raw.githubusercontent.com/my-org/shared-rules/main/style.md"]



}

```

Удаленные инструкции извлекаются с таймаутом в 5 секунд.
Все файлы инструкций объединяются с вашими файлами `AGENTS.md`.
* * *

