<!-- Source: https://opencode.ai/docs/ru/permissions -->

## [Детальные правила (синтаксис объекта)](https://opencode.ai/docs/ru/permissions#%D0%B4%D0%B5%D1%82%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D0%BF%D1%80%D0%B0%D0%B2%D0%B8%D0%BB%D0%B0-%D1%81%D0%B8%D0%BD%D1%82%D0%B0%D0%BA%D1%81%D0%B8%D1%81-%D0%BE%D0%B1%D1%8A%D0%B5%D0%BA%D1%82%D0%B0)
Для большинства разрешений вы можете использовать объект для применения различных действий на основе входных данных инструмента.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"bash": {




"*": "ask",




"git *": "allow",




"npm *": "allow",




"rm *": "deny",




"grep *": "allow"



},



"edit": {




"*": "deny",




"packages/web/src/content/docs/*.mdx": "allow"



}


}


}

```

Правила оцениваются по шаблону, при этом **выигрывает последнее совпадающее правило**. Обычно сначала ставится универсальное правило `"*"`, а после него — более конкретные правила.

### [Подстановочные знаки](https://opencode.ai/docs/ru/permissions#%D0%BF%D0%BE%D0%B4%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%BE%D1%87%D0%BD%D1%8B%D0%B5-%D0%B7%D0%BD%D0%B0%D0%BA%D0%B8)
В шаблонах разрешений используется простое сопоставление с подстановочными знаками:
  * `*` соответствует нулю или более любого символа.
  * `?` соответствует ровно одному символу
  * Все остальные символы совпадают буквально

### [Расширение домашнего каталога](https://opencode.ai/docs/ru/permissions#%D1%80%D0%B0%D1%81%D1%88%D0%B8%D1%80%D0%B5%D0%BD%D0%B8%D0%B5-%D0%B4%D0%BE%D0%BC%D0%B0%D1%88%D0%BD%D0%B5%D0%B3%D0%BE-%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3%D0%B0)
Вы можете использовать `~` или `$HOME` в начале шаблона для ссылки на ваш домашний каталог. Это особенно полезно для правил [`external_directory`](https://opencode.ai/docs/ru/permissions#external-directories).
  * `~/projects/*` -> `/Users/username/projects/*`
  * `$HOME/projects/*` -> `/Users/username/projects/*`
  * `~` -> `/Users/username`

### [Внешние каталоги](https://opencode.ai/docs/ru/permissions#%D0%B2%D0%BD%D0%B5%D1%88%D0%BD%D0%B8%D0%B5-%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3%D0%B8)
Используйте `external_directory`, чтобы разрешить вызовы инструментов, затрагивающие пути за пределами рабочего каталога, в котором был запущен opencode. Это применимо к любому инструменту, который принимает путь в качестве входных данных (например, `read`, `edit`, `list`, `glob`, `grep` и многие команды `bash`).
Расширение дома (например, `~/...`) влияет только на запись шаблона. Он не делает внешний путь частью текущего рабочего пространства, поэтому пути за пределами рабочего каталога все равно должны быть разрешены через `external_directory`.
Например, это позволяет получить доступ ко всему, что находится под `~/projects/personal/`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"external_directory": {




"~/projects/personal/**": "allow"



}


}


}

```

Любой каталог, разрешенный здесь, наследует те же настройки по умолчанию, что и текущая рабочая область. Поскольку для [`read` по умолчанию установлено значение `allow`](https://opencode.ai/docs/ru/permissions#defaults), чтение также разрешено для записей под `external_directory`, если оно не переопределено. Добавьте явные правила, когда инструмент должен быть ограничен в этих путях, например, блокировать редактирование при сохранении чтения:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"external_directory": {




"~/projects/personal/**": "allow"



},



"edit": {




"~/projects/personal/**": "deny"



}


}


}

```

Держите список сосредоточенным на доверенных путях и добавляйте дополнительные правила разрешения или запрета по мере необходимости для других инструментов (например, `bash`).
* * *

