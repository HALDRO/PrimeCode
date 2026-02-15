<!-- Source: https://opencode.ai/docs/ru/skills -->

## [Отключить инструмент навыков](https://opencode.ai/docs/ru/skills#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D1%8C-%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82-%D0%BD%D0%B0%D0%B2%D1%8B%D0%BA%D0%BE%D0%B2)
Полностью отключить навыки для агентов, которым не следует их использовать:
**Для индивидуальных агентов** :
```

---



tools:




skill: false



---

```

**Для встроенных агентов** :
```

{



"agent": {




"plan": {




"tools": {




"skill": false



}


}


}


}

```

Если этот параметр отключен, раздел `<available_skills>` полностью опускается.
* * *

