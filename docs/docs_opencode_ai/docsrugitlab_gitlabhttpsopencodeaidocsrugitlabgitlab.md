<!-- Source: https://opencode.ai/docs/ru/gitlab -->

## [GitLab](https://opencode.ai/docs/ru/gitlab#gitlab)
opencode работает в обычном конвейере GitLab. Вы можете встроить его в конвейер как [CI-компонент](https://docs.gitlab.com/ee/ci/components/)
Здесь мы используем созданный сообществом компонент CI/CD для opencode — [nagyv/gitlab-opencode](https://gitlab.com/nagyv/gitlab-opencode).
* * *

### [Функции](https://opencode.ai/docs/ru/gitlab#%D1%84%D1%83%D0%BD%D0%BA%D1%86%D0%B8%D0%B8)
  * **Использовать пользовательскую конфигурацию для каждого задания**. Настройте opencode с помощью пользовательского каталога конфигурации, например `./config/#custom-directory`, чтобы включать или отключать функциональность для каждого вызова opencode.
  * **Минимальная настройка** : компонент CI настраивает opencode в фоновом режиме, вам нужно только создать конфигурацию opencode и начальное приглашение.
  * **Гибкость** : компонент CI поддерживает несколько входных данных для настройки его поведения.


* * *

### [Настройка](https://opencode.ai/docs/ru/gitlab#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
  1. Сохраните JSON аутентификации opencode как переменные среды CI типа файла в разделе **Настройки** > **CI/CD** > **Переменные**. Обязательно пометьте их как «Замаскированные и скрытые».
  2. Добавьте следующее в файл `.gitlab-ci.yml`.
.gitlab-ci.yml```


include:




- component: $CI_SERVER_FQDN/nagyv/gitlab-opencode/opencode@2




inputs:




config_dir: ${CI_PROJECT_DIR}/opencode-config




auth_json: $OPENCODE_AUTH_JSON# The variable name for your OpenCode authentication JSON




command: optional-custom-command




message: "Your prompt here"


```



Дополнительные сведения и варианты использования см. в документации ](<https://gitlab.com/explore/catalog/nagyv/gitlab-opencode>) для этого компонента.
* * *

