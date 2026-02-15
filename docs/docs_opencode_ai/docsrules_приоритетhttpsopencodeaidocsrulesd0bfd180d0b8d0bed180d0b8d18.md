<!-- Source: https://opencode.ai/docs/rules -->

## [Приоритет](https://opencode.ai/docs/rules#%D0%BF%D1%80%D0%B8%D0%BE%D1%80%D0%B8%D1%82%D0%B5%D1%82)
Когда opencode запускается, он ищет файлы правил в следующем порядке:
  1. **Локальные файлы** путем перехода вверх из текущего каталога (`AGENTS.md`, `CLAUDE.md`)
  2. **Глобальный файл** в `~/.config/opencode/AGENTS.md`.
  3. **Файл кода Клауда** по адресу `~/.claude/CLAUDE.md` (если не отключено)


Первый совпадающий файл побеждает в каждой категории. Например, если у вас есть и `AGENTS.md`, и `CLAUDE.md`, используется только `AGENTS.md`. Аналогично, `~/.config/opencode/AGENTS.md` имеет приоритет над `~/.claude/CLAUDE.md`.
* * *

