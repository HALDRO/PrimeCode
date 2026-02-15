<!-- Source: https://opencode.ai/docs/rules -->

## [Ссылки на внешние файлы](https://opencode.ai/docs/rules#%D1%81%D1%81%D1%8B%D0%BB%D0%BA%D0%B8-%D0%BD%D0%B0-%D0%B2%D0%BD%D0%B5%D1%88%D0%BD%D0%B8%D0%B5-%D1%84%D0%B0%D0%B9%D0%BB%D1%8B)
Хотя opencode не анализирует автоматически ссылки на файлы в `AGENTS.md`, аналогичной функциональности можно добиться двумя способами:

### [Использование opencode.json](https://opencode.ai/docs/rules#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-opencodejson)
Рекомендуемый подход — использовать поле `instructions` в `opencode.json`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"instructions": ["docs/development-standards.md", "test/testing-guidelines.md", "packages/*/AGENTS.md"]



}

```

### [Ручные инструкции в AGENTS.md](https://opencode.ai/docs/rules#%D1%80%D1%83%D1%87%D0%BD%D1%8B%D0%B5-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%86%D0%B8%D0%B8-%D0%B2-agentsmd)
Вы можете научить opencode читать внешние файлы, предоставив явные инструкции в файле `AGENTS.md`. Вот практический пример:
AGENTS.md```

