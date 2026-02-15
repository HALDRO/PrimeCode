<!-- Source: https://opencode.ai/docs/share -->

## [Совместное использование](https://opencode.ai/docs/share#%D1%81%D0%BE%D0%B2%D0%BC%D0%B5%D1%81%D1%82%D0%BD%D0%BE%D0%B5-%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5)
opencode поддерживает три режима общего доступа, которые контролируют общий доступ к разговорам:
* * *

### [Ручной (по умолчанию)](https://opencode.ai/docs/share#%D1%80%D1%83%D1%87%D0%BD%D0%BE%D0%B9-%D0%BF%D0%BE-%D1%83%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D0%BD%D0%B8%D1%8E)
По умолчанию opencode использует режим совместного использования вручную. Сессии не передаются автоматически, но вы можете поделиться ими вручную с помощью команды `/share`:
```

/share

```

Это создаст уникальный URL-адрес, который будет скопирован в буфер обмена.
Чтобы явно установить ручной режим в вашем [файле конфигурации](https://opencode.ai/docs/config):
opencode.json```

{



"$schema": "https://opncd.ai/config.json",




"share": "manual"



}

```

* * *

### [Автоматическая публикация](https://opencode.ai/docs/share#%D0%B0%D0%B2%D1%82%D0%BE%D0%BC%D0%B0%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B0%D1%8F-%D0%BF%D1%83%D0%B1%D0%BB%D0%B8%D0%BA%D0%B0%D1%86%D0%B8%D1%8F)
Вы можете включить автоматический общий доступ для всех новых разговоров, установив для параметра `share` значение `"auto"` в вашем [файле конфигурации](https://opencode.ai/docs/config):
opencode.json```

{



"$schema": "https://opncd.ai/config.json",




"share": "auto"



}

```

Если функция автоматического обмена включена, каждый новый разговор будет автоматически опубликован и будет создана ссылка.
* * *

### [Отключено](https://opencode.ai/docs/share#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%BE)
Вы можете полностью отключить общий доступ, установив для параметра `share` значение `"disabled"` в вашем [файле конфигурации](https://opencode.ai/docs/config):
opencode.json```

{



"$schema": "https://opncd.ai/config.json",




"share": "disabled"



}

```

Чтобы обеспечить соблюдение этого правила для всей вашей команды в конкретном проекте, добавьте его в `opencode.json` вашего проекта и зарегистрируйтесь в Git.
* * *

