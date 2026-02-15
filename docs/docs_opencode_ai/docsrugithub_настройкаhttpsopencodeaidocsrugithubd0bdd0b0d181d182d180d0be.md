<!-- Source: https://opencode.ai/docs/ru/github -->

## [Настройка](https://opencode.ai/docs/ru/github#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
  * `model`: модель для использования с opencode. Принимает формат `provider/model`. Это **обязательно**.
  * `agent`: используемый агент. Должен быть основным агентом. Возвращается к `default_agent` из конфигурации или к `"build"`, если не найден.
  * `share`: следует ли предоставлять общий доступ к сеансу opencode. По умолчанию **true** для общедоступных репозиториев.
  * `prompt`: дополнительный настраиваемый запрос для переопределения поведения по умолчанию. Используйте это, чтобы настроить обработку запросов opencode.
  * `token`: дополнительный токен доступа GitHub для выполнения таких операций, как создание комментариев, фиксация изменений и открытие запросов на включение. По умолчанию opencode использует токен доступа к установке из приложения opencode GitHub, поэтому фиксации, комментарии и запросы на включение отображаются как исходящие из приложения.
Кроме того, вы можете использовать [встроенный `GITHUB_TOKEN`](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) средства запуска действий GitHub без установки приложения opencode GitHub. Просто не забудьте предоставить необходимые разрешения в вашем рабочем процессе:
```


permissions:




id-token: write




contents: write




pull-requests: write




issues: write


```

Вы также можете использовать [токены личного доступа](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)(PAT), если предпочитаете.


* * *

