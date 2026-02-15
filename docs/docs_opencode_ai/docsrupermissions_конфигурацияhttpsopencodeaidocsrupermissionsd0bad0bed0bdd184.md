<!-- Source: https://opencode.ai/docs/ru/permissions -->

## [Конфигурация](https://opencode.ai/docs/ru/permissions#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
Вы можете устанавливать разрешения глобально (с помощью `*`) и переопределять определенные инструменты.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"*": "ask",




"bash": "allow",




"edit": "deny"



}


}

```

Вы также можете установить все разрешения одновременно:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": "allow"



}

```

* * *

