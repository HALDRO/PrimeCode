<!-- Source: https://opencode.ai/docs/rules -->

## [Типы](https://opencode.ai/docs/rules#%D1%82%D0%B8%D0%BF%D1%8B)
opencode также поддерживает чтение файла `AGENTS.md` из нескольких мест. И это служит разным целям.

### [Проект](https://opencode.ai/docs/rules#%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82)
Поместите `AGENTS.md` в корень вашего проекта для правил, специфичных для проекта. Они применяются только тогда, когда вы работаете в этом каталоге или его подкаталогах.

### [Глобальный](https://opencode.ai/docs/rules#%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9)
Вы также можете иметь глобальные правила в файле `~/.config/opencode/AGENTS.md`. Это применяется ко всем сеансам opencode.
Поскольку это не коммитится в Git и не передается вашей команде, мы рекомендуем использовать его для указания любых личных правил, которым должен следовать LLM.

### [Совместимость кода Клода](https://opencode.ai/docs/rules#%D1%81%D0%BE%D0%B2%D0%BC%D0%B5%D1%81%D1%82%D0%B8%D0%BC%D0%BE%D1%81%D1%82%D1%8C-%D0%BA%D0%BE%D0%B4%D0%B0-%D0%BA%D0%BB%D0%BE%D0%B4%D0%B0)
Для пользователей, переходящих с Claude Code, opencode поддерживает файловые соглашения Claude Code в качестве резерва:
  * **Правила проекта** : `CLAUDE.md` в каталоге вашего проекта (используется, если `AGENTS.md` не существует).
  * **Глобальные правила** : `~/.claude/CLAUDE.md` (используется, если `~/.config/opencode/AGENTS.md` не существует).
  * **Навыки** : `~/.claude/skills/` — подробности см. в [Навыки агента](https://opencode.ai/docs/skills/).


Чтобы отключить совместимость Claude Code, установите одну из этих переменных среды:
Окно терминала```


export OPENCODE_DISABLE_CLAUDE_CODE=1# Disable all .claude support




export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1# Disable only ~/.claude/CLAUDE.md




export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1# Disable only .claude/skills


```

* * *

