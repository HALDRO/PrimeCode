<!-- Source: https://opencode.ai/docs/ru/skills -->

## [Настройка разрешений](https://opencode.ai/docs/ru/skills#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0-%D1%80%D0%B0%D0%B7%D1%80%D0%B5%D1%88%D0%B5%D0%BD%D0%B8%D0%B9)
Контролируйте, к каким навыкам агенты могут получить доступ, используя разрешения на основе шаблонов в `opencode.json`:
```

{



"permission": {




"skill": {




"*": "allow",




"pr-review": "allow",




"internal-*": "deny",




"experimental-*": "ask"



}


}


}

```

Разрешение | Поведение  
---|---  
`allow` | Skill loads immediately  
`deny` | Skill hidden from agent, access rejected  
`ask` | User prompted for approval before loading  
Шаблоны поддерживают подстановочные знаки: `internal-*` соответствует `internal-docs`, `internal-tools` и т. д.
* * *

