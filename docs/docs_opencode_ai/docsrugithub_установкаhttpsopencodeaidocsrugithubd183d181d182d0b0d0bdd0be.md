<!-- Source: https://opencode.ai/docs/ru/github -->

## [Установка](https://opencode.ai/docs/ru/github#%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%BA%D0%B0)
Запустите следующую команду в проекте, который находится в репозитории GitHub:
Окно терминала```


opencodegithubinstall


```

Это поможет вам установить приложение GitHub, создать рабочий процесс и настроить secrets (секреты).
* * *

### [Ручная настройка](https://opencode.ai/docs/ru/github#%D1%80%D1%83%D1%87%D0%BD%D0%B0%D1%8F-%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Или вы можете настроить его вручную.
  1. **Установите приложение GitHub**
Перейдите на [**github.com/apps/opencode-agent**](https://github.com/apps/opencode-agent). Убедитесь, что он установлен в целевом репозитории.
  2. **Добавьте рабочий процесс**
Добавьте следующий файл рабочего процесса в `.github/workflows/opencode.yml` в своем репозитории. Обязательно установите соответствующий `model` и необходимые ключи API в `env`.
.github/workflows/opencode.yml```


name: opencode




on:




issue_comment:




types: [created]




pull_request_review_comment:




types: [created]




jobs:




opencode:




if: |



contains(github.event.comment.body, '/oc') ||


contains(github.event.comment.body, '/opencode')



runs-on: ubuntu-latest




permissions:




id-token: write




steps:




- name: Checkout repository




uses: actions/checkout@v6




with:




fetch-depth: 1




persist-credentials: false




- name: Run OpenCode




uses: anomalyco/opencode/github@latest




env:




ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}




with:




model: anthropic/claude-sonnet-4-20250514

