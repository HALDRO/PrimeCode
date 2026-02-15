<!-- Source: https://opencode.ai/docs/ru/skills -->

## [Распознавание описания инструмента](https://opencode.ai/docs/ru/skills#%D1%80%D0%B0%D1%81%D0%BF%D0%BE%D0%B7%D0%BD%D0%B0%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-%D0%BE%D0%BF%D0%B8%D1%81%D0%B0%D0%BD%D0%B8%D1%8F-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%B0)
opencode перечисляет доступные навыки в описании инструмента `skill`. Каждая запись включает название и описание навыка:
```


<available_skills>




<skill>




<name>git-release</name>




<description>Create consistent releases and changelogs</description>




</skill>




</available_skills>


```

Агент загружает навык, вызывая инструмент:
```

skill({ name: "git-release" })

```

* * *

