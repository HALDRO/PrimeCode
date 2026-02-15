<!-- Source: https://opencode.ai/docs/ru/troubleshooting -->

## [Настольное приложение](https://opencode.ai/docs/ru/troubleshooting#%D0%BD%D0%B0%D1%81%D1%82%D0%BE%D0%BB%D1%8C%D0%BD%D0%BE%D0%B5-%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5)
opencode Desktop запускает локальный сервер opencode (спутник `opencode-cli`) в фоновом режиме. Большинство проблем вызвано неправильно работающим плагином, поврежденным кешем или неверными настройками сервера.

### [Быстрые проверки](https://opencode.ai/docs/ru/troubleshooting#%D0%B1%D1%8B%D1%81%D1%82%D1%80%D1%8B%D0%B5-%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B8)
  * Полностью закройте и перезапустите приложение.
  * Если приложение отображает экран с ошибкой, нажмите **Перезапустить** и скопируйте сведения об ошибке.
  * Только для macOS: меню `OpenCode` -> **Обновить веб-просмотр** (помогает, если пользовательский интерфейс пуст или завис).


* * *

### [Отключить плагины](https://opencode.ai/docs/ru/troubleshooting#%D0%BE%D1%82%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D1%8C-%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD%D1%8B)
Если настольное приложение дает сбой при запуске, зависает или ведет себя странно, начните с отключения плагинов.
#### [Проверьте глобальную конфигурацию](https://opencode.ai/docs/ru/troubleshooting#%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D1%8C%D1%82%D0%B5-%D0%B3%D0%BB%D0%BE%D0%B1%D0%B0%D0%BB%D1%8C%D0%BD%D1%83%D1%8E-%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8E)
Откройте файл глобальной конфигурации и найдите ключ `plugin`.
  * **macOS/Linux** : `~/.config/opencode/opencode.jsonc` (или `~/.config/opencode/opencode.json`)
  * **macOS/Linux** (более ранние версии): `~/.local/share/opencode/opencode.jsonc`
  * **Windows** : нажмите `WIN+R` и вставьте `%USERPROFILE%\.config\opencode\opencode.jsonc`.


Если у вас настроены плагины, временно отключите их, удалив ключ или установив для него пустой массив:
```

{



"$schema": "https://opencode.ai/config.json",




"plugin": [],



}

```

#### [Проверьте каталоги плагинов](https://opencode.ai/docs/ru/troubleshooting#%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D1%8C%D1%82%D0%B5-%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3%D0%B8-%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD%D0%BE%D0%B2)
opencode также может загружать локальные плагины с диска. Временно переместите их в сторону (или переименуйте папку) и перезапустите настольное приложение:
  * **Глобальные плагины**
    * **macOS/Linux** : `~/.config/opencode/plugins/`
    * **Windows** : нажмите `WIN+R` и вставьте `%USERPROFILE%\.config\opencode\plugins`.
  * **Плагины проекта** (только если вы используете конфигурацию для каждого проекта) 
    * `<your-project>/.opencode/plugins/`


Если приложение снова начнет работать, повторно включите плагины по одному, чтобы определить, какой из них вызывает проблему.
* * *

### [Очистить кеш](https://opencode.ai/docs/ru/troubleshooting#%D0%BE%D1%87%D0%B8%D1%81%D1%82%D0%B8%D1%82%D1%8C-%D0%BA%D0%B5%D1%88)
Если отключение плагинов не помогает (или установка плагина зависла), очистите кеш, чтобы opencode мог его пересобрать.
  1. Полностью закройте opencode Desktop.
  2. Удалите каталог кэша:


  * **macOS** : Finder -> `Cmd+Shift+G` -> вставить `~/.cache/opencode`.
  * **Linux** : удалите `~/.cache/opencode` (или запустите `rm -rf ~/.cache/opencode`).
  * **Windows** : нажмите `WIN+R` и вставьте `%USERPROFILE%\.cache\opencode`.


  1. Перезапустите рабочий стол opencode.


* * *

### [Исправить проблемы с подключением к серверу](https://opencode.ai/docs/ru/troubleshooting#%D0%B8%D1%81%D0%BF%D1%80%D0%B0%D0%B2%D0%B8%D1%82%D1%8C-%D0%BF%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B-%D1%81-%D0%BF%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5%D0%BC-%D0%BA-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D1%83)
opencode Desktop может либо запустить собственный локальный сервер (по умолчанию), либо подключиться к настроенному вами URL-адресу сервера.
Если вы видите диалоговое окно **Ошибка подключения** (или приложение никогда не выходит за пределы заставки), проверьте URL-адрес пользовательского сервера.
#### [Очистите URL-адрес сервера по умолчанию для рабочего стола.](https://opencode.ai/docs/ru/troubleshooting#%D0%BE%D1%87%D0%B8%D1%81%D1%82%D0%B8%D1%82%D0%B5-url-%D0%B0%D0%B4%D1%80%D0%B5%D1%81-%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80%D0%B0-%D0%BF%D0%BE-%D1%83%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D0%BD%D0%B8%D1%8E-%D0%B4%D0%BB%D1%8F-%D1%80%D0%B0%D0%B1%D0%BE%D1%87%D0%B5%D0%B3%D0%BE-%D1%81%D1%82%D0%BE%D0%BB%D0%B0)
На главном экране щелкните имя сервера (с точкой состояния), чтобы открыть окно выбора сервера. В разделе **Сервер по умолчанию** нажмите **Очистить**.
#### [Удалите `server.port`/`server.hostname` из вашей конфигурации.](https://opencode.ai/docs/ru/troubleshooting#%D1%83%D0%B4%D0%B0%D0%BB%D0%B8%D1%82%D0%B5-serverportserverhostname-%D0%B8%D0%B7-%D0%B2%D0%B0%D1%88%D0%B5%D0%B9-%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D0%B8)
Если ваш `opencode.json(c)` содержит раздел `server`, временно удалите его и перезапустите настольное приложение.
#### [Проверьте переменные среды](https://opencode.ai/docs/ru/troubleshooting#%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D1%8C%D1%82%D0%B5-%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%8B)
Если в вашей среде установлен `OPENCODE_PORT`, настольное приложение попытается использовать этот порт для локального сервера.
  * Отмените настройку `OPENCODE_PORT` (или выберите свободный порт) и перезапустите.


* * *

### [Linux: проблемы с Wayland/X11](https://opencode.ai/docs/ru/troubleshooting#linux-%D0%BF%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B-%D1%81-waylandx11)
В Linux некоторые настройки Wayland могут вызывать пустые окна или ошибки компоновщика.
  * Если вы используете Wayland, а приложение не работает или вылетает, попробуйте запустить с помощью `OC_ALLOW_WAYLAND=1`.
  * Если это усугубляет ситуацию, удалите его и попробуйте вместо этого запустить сеанс X11.


* * *

### [Windows: среда выполнения WebView2.](https://opencode.ai/docs/ru/troubleshooting#windows-%D1%81%D1%80%D0%B5%D0%B4%D0%B0-%D0%B2%D1%8B%D0%BF%D0%BE%D0%BB%D0%BD%D0%B5%D0%BD%D0%B8%D1%8F-webview2)
В Windows для opencode Desktop требуется Microsoft Edge **WebView2 Runtime**. Если приложение открывается в пустом окне или не запускается, установите/обновите WebView2 и повторите попытку.
* * *

### [Windows: общие проблемы с производительностью](https://opencode.ai/docs/ru/troubleshooting#windows-%D0%BE%D0%B1%D1%89%D0%B8%D0%B5-%D0%BF%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B-%D1%81-%D0%BF%D1%80%D0%BE%D0%B8%D0%B7%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%BE%D1%81%D1%82%D1%8C%D1%8E)
Если вы испытываете низкую производительность, проблемы с доступом к файлам или проблемы с terminal в Windows, попробуйте использовать [WSL (подсистема Windows для Linux)](https://opencode.ai/docs/windows-wsl). WSL предоставляет среду Linux, которая более эффективно работает с функциями opencode.
* * *

### [Уведомления не отображаются](https://opencode.ai/docs/ru/troubleshooting#%D1%83%D0%B2%D0%B5%D0%B4%D0%BE%D0%BC%D0%BB%D0%B5%D0%BD%D0%B8%D1%8F-%D0%BD%D0%B5-%D0%BE%D1%82%D0%BE%D0%B1%D1%80%D0%B0%D0%B6%D0%B0%D1%8E%D1%82%D1%81%D1%8F)
opencode Desktop отображает системные уведомления только в следующих случаях:
  * уведомления для opencode включены в настройках вашей ОС, и
  * окно приложения не в фокусе.


* * *

### [Сбросить хранилище настольных приложений (последнее средство)](https://opencode.ai/docs/ru/troubleshooting#%D1%81%D0%B1%D1%80%D0%BE%D1%81%D0%B8%D1%82%D1%8C-%D1%85%D1%80%D0%B0%D0%BD%D0%B8%D0%BB%D0%B8%D1%89%D0%B5-%D0%BD%D0%B0%D1%81%D1%82%D0%BE%D0%BB%D1%8C%D0%BD%D1%8B%D1%85-%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B9-%D0%BF%D0%BE%D1%81%D0%BB%D0%B5%D0%B4%D0%BD%D0%B5%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%81%D1%82%D0%B2%D0%BE)
Если приложение не запускается и вы не можете очистить настройки из пользовательского интерфейса, сбросьте сохраненное состояние настольного приложения.
  1. Закройте рабочий стол opencode.
  2. Найдите и удалите эти файлы (они находятся в каталоге данных приложения opencode Desktop):


  * `opencode.settings.dat` (URL-адрес сервера по умолчанию для рабочего стола)
  * `opencode.global.dat` и `opencode.workspace.*.dat` (состояние пользовательского интерфейса, например, недавние серверы/проекты)


Чтобы быстро найти каталог:
  * **macOS** : Finder -> `Cmd+Shift+G` -> `~/Library/Application Support` (затем найдите имена файлов, указанные выше)
  * **Linux** : найдите в `~/.local/share` имена файлов, указанные выше.
  * **Windows** : нажмите `WIN+R` -> `%APPDATA%` (затем найдите имена файлов, указанные выше).


* * *

