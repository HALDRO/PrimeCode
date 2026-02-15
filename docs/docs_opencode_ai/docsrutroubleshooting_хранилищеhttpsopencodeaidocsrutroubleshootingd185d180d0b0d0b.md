<!-- Source: https://opencode.ai/docs/ru/troubleshooting -->

## [Хранилище](https://opencode.ai/docs/ru/troubleshooting#%D1%85%D1%80%D0%B0%D0%BD%D0%B8%D0%BB%D0%B8%D1%89%D0%B5)
opencode хранит данные сеанса и другие данные приложения на диске по адресу:
  * **macOS/Linux** : `~/.local/share/opencode/`
  * **Windows** : нажмите `WIN+R` и вставьте `%USERPROFILE%\.local\share\opencode`.


Этот каталог содержит:
  * `auth.json` – данные аутентификации, такие как ключи API и токены OAuth.
  * `log/` – журналы приложений.
  * `project/` — данные, специфичные для проекта, такие как данные сеанса и сообщения. 
    * Если проект находится в репозитории Git, он хранится в `./<project-slug>/storage/`.
    * Если это не репозиторий Git, он хранится в `./global/storage/`.


* * *

