<!-- Source: https://opencode.ai/docs/ru/windows-wsl -->

## [Доступ к файлам Windows](https://opencode.ai/docs/ru/windows-wsl#%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF-%D0%BA-%D1%84%D0%B0%D0%B9%D0%BB%D0%B0%D0%BC-windows)
WSL может получать доступ ко всем вашим файлам Windows через каталог `/mnt/`:
  * `C:` drive → `/mnt/c/`
  * `D:` drive → `/mnt/d/`
  * И так далее


Пример:
Окно терминала```


cd/mnt/c/Users/YourName/Documents/project



opencode

```

Для максимально плавной работы стоит клонировать или скопировать репозиторий в файловую систему WSL (например, в `~/code/`) и запускать opencode оттуда.
* * *

