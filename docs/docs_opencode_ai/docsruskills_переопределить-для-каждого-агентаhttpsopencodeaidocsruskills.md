<!-- Source: https://opencode.ai/docs/ru/skills -->

## [Переопределить для каждого агента](https://opencode.ai/docs/ru/skills#%D0%BF%D0%B5%D1%80%D0%B5%D0%BE%D0%BF%D1%80%D0%B5%D0%B4%D0%B5%D0%BB%D0%B8%D1%82%D1%8C-%D0%B4%D0%BB%D1%8F-%D0%BA%D0%B0%D0%B6%D0%B4%D0%BE%D0%B3%D0%BE-%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D0%B0)
Предоставьте конкретным агентам разрешения, отличные от глобальных настроек по умолчанию.
**Для пользовательских агентов** (в заголовке агента):
```

---



permission:




skill:




"documents-*": "allow"



---

```

**Для встроенных агентов** (в формате `opencode.json`):
```

{



"agent": {




"plan": {




"permission": {




"skill": {




"internal-*": "allow"



}


}


}


}


}

```

* * *

