<!-- Source: https://opencode.ai/docs/ru/tui -->

## [Настройка](https://opencode.ai/docs/ru/tui#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете настроить поведение TUI через файл конфигурации opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"tui": {




"scroll_speed": 3,




"scroll_acceleration": {




"enabled": true



}


}


}

```

### [Параметры](https://opencode.ai/docs/ru/tui#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B)
  * `scroll_acceleration` — включите ускорение прокрутки в стиле macOS для плавной и естественной прокрутки. Если этот параметр включен, скорость прокрутки увеличивается при быстрой прокрутке и остается точной при более медленных движениях. **Этот параметр имеет приоритет над`scroll_speed` и переопределяет его, если он включен.**
  * `scroll_speed` — контролирует скорость прокрутки TUI при использовании команд прокрутки (минимум: `1`). По умолчанию `3`. **Примечание. Это игнорируется, если для`scroll_acceleration.enabled` установлено значение `true`.**


* * *

