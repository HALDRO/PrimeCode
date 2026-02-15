<!-- Source: https://opencode.ai/docs/ru/troubleshooting -->

## [Журналы](https://opencode.ai/docs/ru/troubleshooting#%D0%B6%D1%83%D1%80%D0%BD%D0%B0%D0%BB%D1%8B)
Лог-файлы записываются в:
  * **macOS/Linux** : `~/.local/share/opencode/log/`
  * **Windows** : нажмите `WIN+R` и вставьте `%USERPROFILE%\.local\share\opencode\log`.


Файлам журналов присваиваются имена с метками времени (например, `2025-01-09T123456.log`), и сохраняются 10 последних файлов журналов.
Вы можете установить уровень журнала с помощью CLI-параметра `--log-level`, чтобы получить более подробную информацию об отладке. Например, `opencode --log-level DEBUG`.
* * *

