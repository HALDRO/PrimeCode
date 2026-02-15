<!-- Source: https://opencode.ai/docs/ru/github -->

## [Поддерживаемые события](https://opencode.ai/docs/ru/github#%D0%BF%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%B8%D0%B2%D0%B0%D0%B5%D0%BC%D1%8B%D0%B5-%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D1%8F)
opencode может быть запущен следующими событиями GitHub:
Тип события | Инициировано | Подробности  
---|---|---  
`issue_comment` | Комментарий к проблеме или PR | Упомяните `/opencode` или `/oc` в своем комментарии. opencode считывает контекст и может создавать ветки, открывать PR или отвечать.  
`pull_request_review_comment` | Комментируйте конкретные строки кода в PR. | Упоминайте `/opencode` или `/oc` при просмотре кода. opencode получает путь к файлу, номера строк и контекст сравнения.  
`issues` | Issue открыт или изменен | Автоматически запускать opencode при создании или изменении проблем. Требуется ввод `prompt`.  
`pull_request` | PR открыт или обновлен | Автоматически запускать opencode при открытии, синхронизации или повторном открытии PR. Полезно для автоматических обзоров.  
`schedule` | Расписание на основе Cron | Запускайте opencode по расписанию. Требуется ввод `prompt`. Вывод поступает в журналы и PR (комментариев нет).  
`workflow_dispatch` | Ручной триггер из пользовательского интерфейса GitHub | Запускайте opencode по требованию на вкладке «Действия». Требуется ввод `prompt`. Вывод идет в логи и PR.

### [Пример: Расписание](https://opencode.ai/docs/ru/github#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80-%D1%80%D0%B0%D1%81%D0%BF%D0%B8%D1%81%D0%B0%D0%BD%D0%B8%D0%B5)
Запускайте opencode по расписанию для выполнения автоматизированных задач:
.github/workflows/opencode-scheduled.yml```


name: Scheduled OpenCode Task




on:




schedule:




- cron: "0 9 * * 1"# Every Monday at 9am UTC




jobs:




opencode:




runs-on: ubuntu-latest




permissions:




id-token: write




contents: write




pull-requests: write




issues: write




steps:




- name: Checkout repository




uses: actions/checkout@v6




with:




persist-credentials: false




- name: Run OpenCode




uses: anomalyco/opencode/github@latest




env:




ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}




with:




model: anthropic/claude-sonnet-4-20250514




prompt: |



Review the codebase for any TODO comments and create a summary.


If you find issues worth addressing, open an issue to track them.

```

Для запланированных событий вход `prompt` **обязателен** , поскольку нет комментария, из которого можно было бы извлечь инструкции. Запланированные рабочие процессы выполняются без пользовательского контекста для проверки разрешений, поэтому рабочий процесс должен предоставлять `contents: write` и `pull-requests: write`, если вы ожидаете, что opencode будет создавать ветки или PR.
* * *

### [Пример: Pull Request](https://opencode.ai/docs/ru/github#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80-pull-request)
Автоматически просматривать PR при их открытии или обновлении:
.github/workflows/opencode-review.yml```


name: opencode-review




on:




pull_request:




types: [opened, synchronize, reopened, ready_for_review]




jobs:




review:




runs-on: ubuntu-latest




permissions:




id-token: write




contents: read




pull-requests: read




issues: read




steps:




- uses: actions/checkout@v6




with:




persist-credentials: false




- uses: anomalyco/opencode/github@latest




env:




ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}




GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}




with:




model: anthropic/claude-sonnet-4-20250514




use_github_token: true




prompt: |



Review this pull request:


- Check for code quality issues


- Look for potential bugs


- Suggest improvements

```

Если для событий `pull_request` не указан `prompt`, opencode по умолчанию проверяет запрос на включение.
* * *

### [Пример: Сортировка Issue](https://opencode.ai/docs/ru/github#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80-%D1%81%D0%BE%D1%80%D1%82%D0%B8%D1%80%D0%BE%D0%B2%D0%BA%D0%B0-issue)
Автоматически сортируйте новые проблемы. В этом примере фильтруется аккаунты, созданные более 30 дней назад, чтобы уменьшить количество спама:
.github/workflows/opencode-triage.yml```


name: Issue Triage




on:




issues:




types: [opened]




jobs:




triage:




runs-on: ubuntu-latest




permissions:




id-token: write




contents: write




pull-requests: write




issues: write




steps:




- name: Check account age




id: check




uses: actions/github-script@v7




with:




script: |



const user = await github.rest.users.getByUsername({


username: context.payload.issue.user.login


});


const created = new Date(user.data.created_at);


const days = (Date.now() - created) / (1000 * 60 * 60 * 24);


return days >= 30;



result-encoding: string




- uses: actions/checkout@v6




if: steps.check.outputs.result == 'true'




with:




persist-credentials: false




- uses: anomalyco/opencode/github@latest




if: steps.check.outputs.result == 'true'




env:




ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}




with:




model: anthropic/claude-sonnet-4-20250514




prompt: |



Review this issue. If there's a clear fix or relevant docs:


- Provide documentation links


- Add error handling guidance for code examples


Otherwise, do not comment.

```

Для событий `issues` вход `prompt` **обязателен** , поскольку нет комментария, из которого можно было бы извлечь инструкции.
* * *

