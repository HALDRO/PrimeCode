<!-- Source: https://opencode.ai/docs/providers -->

## [Каталог](https://opencode.ai/docs/providers#%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3)
Рассмотрим некоторых провайдеров подробнее. Если вы хотите добавить провайдера в список, смело открывайте PR.
Не видите здесь провайдера? Откройте PR.
* * *

### [302.AI](https://opencode.ai/docs/providers#302ai)
  1. Перейдите в консоль 302.AI](<https://302.ai/>), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **302.AI**.
```

/connect

```

  3. Введите свой ключ API 302.AI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



* * *

### [Amazon Bedrock](https://opencode.ai/docs/providers#amazon-bedrock)
Чтобы использовать Amazon Bedrock с opencode:
  1. Перейдите в **Каталог моделей** в консоли Amazon Bedrock и запросите доступ к нужным моделям.
Вам необходимо иметь доступ к нужной модели в Amazon Bedrock.
  2. **Настройте аутентификацию** одним из следующих способов:
#### [Переменные среды (быстрый старт)](https://opencode.ai/docs/providers#%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%8B-%D0%B1%D1%8B%D1%81%D1%82%D1%80%D1%8B%D0%B9-%D1%81%D1%82%D0%B0%D1%80%D1%82)
Установите одну из этих переменных среды при запуске opencode:
Окно терминала```

### [Anthropic](https://opencode.ai/docs/providers#anthropic)
  1. После регистрации введите команду `/connect` и выберите Anthropic.
```

/connect

```

  2. Здесь вы можете выбрать опцию **Claude Pro/Max** , и ваш браузер откроется. и попросите вас пройти аутентификацию.
```

┌ Select auth method


│


│ Claude Pro/Max


│ Create an API Key


│ Manually enter API Key


└

```

  3. Теперь все модели Anthropic должны быть доступны при использовании команды `/models`.
```

/models

```



Использование вашей подписки Claude Pro/Max в opencode официально не поддерживается [Anthropic](https://anthropic.com).
##### [Использование ключей API](https://opencode.ai/docs/providers#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%B9-api)
Вы также можете выбрать **Создать ключ API** , если у вас нет подписки Pro/Max. Он также откроет ваш браузер и попросит вас войти в Anthropic и предоставит вам код, который вы можете вставить в свой терминал.
Или, если у вас уже есть ключ API, вы можете выбрать **Ввести ключ API вручную** и вставить его в свой терминал.
* * *

### [Azure OpenAI](https://opencode.ai/docs/providers#azure-openai)
Если вы столкнулись с ошибками «Извините, но я не могу помочь с этим запросом», попробуйте изменить фильтр содержимого с **DefaultV2** на **Default** в своем ресурсе Azure.
  1. Перейдите на [портал Azure](https://portal.azure.com/) и создайте ресурс **Azure OpenAI**. Вам понадобится:
     * **Имя ресурса** : оно становится частью вашей конечной точки API (`https://RESOURCE_NAME.openai.azure.com/`).
     * **Ключ API** : `KEY 1` или `KEY 2` из вашего ресурса.
  2. Перейдите в [Azure AI Foundry](https://ai.azure.com/) и разверните модель.
:::примечание Для правильной работы opencode имя развертывания должно совпадать с именем модели. :::
  3. Запустите команду `/connect` и найдите **Azure**.
```

/connect

```

  4. Введите свой ключ API.
```

┌ API key


│


│


└ enter

```

  5. Задайте имя ресурса как переменную среды:
Окно терминала```


AZURE_RESOURCE_NAME=XXXopencode


```

Или добавьте его в свой профиль bash:
~/.bash_profile```


export AZURE_RESOURCE_NAME=XXX


```

  6. Запустите команду `/models`, чтобы выбрать развернутую модель.
```

/models

```



* * *

### [Azure Cognitive Services](https://opencode.ai/docs/providers#azure-cognitive-services)
  1. Перейдите на [портал Azure](https://portal.azure.com/) и создайте ресурс **Azure OpenAI**. Вам понадобится:
     * **Имя ресурса** : оно становится частью вашей конечной точки API (`https://AZURE_COGNITIVE_SERVICES_RESOURCE_NAME.cognitiveservices.azure.com/`).
     * **Ключ API** : `KEY 1` или `KEY 2` из вашего ресурса.
  2. Перейдите в [Azure AI Foundry](https://ai.azure.com/) и разверните модель.
:::примечание Для правильной работы opencode имя развертывания должно совпадать с именем модели. :::
  3. Запустите команду `/connect` и найдите **Azure Cognitive Services**.
```

/connect

```

  4. Введите свой ключ API.
```

┌ API key


│


│


└ enter

```

  5. Задайте имя ресурса как переменную среды:
Окно терминала```


AZURE_COGNITIVE_SERVICES_RESOURCE_NAME=XXXopencode


```

Или добавьте его в свой профиль bash:
~/.bash_profile```


export AZURE_COGNITIVE_SERVICES_RESOURCE_NAME=XXX


```

  6. Запустите команду `/models`, чтобы выбрать развернутую модель.
```

/models

```



* * *

### [Baseten](https://opencode.ai/docs/providers#baseten)
  1. Перейдите в [Baseten](https://app.baseten.co/), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **Baseten**.
```

/connect

```

  3. Введите свой ключ API Baseten.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



* * *

### [Cerebras](https://opencode.ai/docs/providers#cerebras)
  1. Перейдите в [консоль Cerebras](https://inference.cerebras.ai/), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **Cerebras**.
```

/connect

```

  3. Введите свой ключ API Cerebras.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Qwen 3 Coder 480B_.
```

/models

```



* * *

### [Cloudflare AI Gateway](https://opencode.ai/docs/providers#cloudflare-ai-gateway)
Cloudflare AI Gateway позволяет вам получать доступ к моделям OpenAI, Anthropic, Workers AI и т. д. через единую конечную точку. Благодаря [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) вам не нужны отдельные ключи API для каждого провайдера.
  1. Перейдите на [панель управления Cloudflare](https://dash.cloudflare.com/), выберите **AI** > **AI Gateway** и создайте новый шлюз.
  2. Установите идентификатор своей учетной записи и идентификатор шлюза в качестве переменных среды.
~/.bash_profile```


export CLOUDFLARE_ACCOUNT_ID=your-32-character-account-id




export CLOUDFLARE_GATEWAY_ID=your-gateway-id


```

  3. Запустите команду `/connect` и найдите **Cloudflare AI Gateway**.
```

/connect

```

  4. Введите свой токен API Cloudflare.
```

┌ API key


│


│


└ enter

```

Или установите его как переменную среды.
~/.bash_profile```


export CLOUDFLARE_API_TOKEN=your-api-token


```

  5. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```

Вы также можете добавлять модели через конфигурацию opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"cloudflare-ai-gateway": {




"models": {




"openai/gpt-4o": {},




"anthropic/claude-sonnet-4": {}



}


}


}


}

```



* * *

### [Cortecs](https://opencode.ai/docs/providers#cortecs)
  1. Перейдите в [консоль Cortecs](https://cortecs.ai/), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **Cortecs**.
```

/connect

```

  3. Введите свой ключ API Cortecs.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Kimi K2 Instruct_.
```

/models

```



* * *

### [DeepSeek](https://opencode.ai/docs/providers#deepseek)
  1. Перейдите в [консоль DeepSeek](https://platform.deepseek.com/), создайте учетную запись и нажмите **Создать новый ключ API**.
  2. Запустите команду `/connect` и найдите **DeepSeek**.
```

/connect

```

  3. Введите свой ключ API DeepSeek.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель DeepSeek, например _DeepSeek Reasoner_.
```

/models

```



* * *

### [Deep Infra](https://opencode.ai/docs/providers#deep-infra)
  1. Перейдите на панель мониторинга Deep Infra](<https://deepinfra.com/dash>), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **Deep Infra**.
```

/connect

```

  3. Введите свой ключ API Deep Infra.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



* * *

### [Firmware](https://opencode.ai/docs/providers#firmware)
  1. Перейдите на [панель Firmware](https://app.firmware.ai/signup), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **Firmware**.
```

/connect

```

  3. Введите ключ API Firmware.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



* * *

### [Fireworks AI](https://opencode.ai/docs/providers#fireworks-ai)
  1. Перейдите в [консоль Fireworks AI](https://app.fireworks.ai/), создайте учетную запись и нажмите **Создать ключ API**.
  2. Запустите команду `/connect` и найдите **Fireworks AI**.
```

/connect

```

  3. Введите ключ API Fireworks AI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Kimi K2 Instruct_.
```

/models

```



* * *

### [GitLab Duo](https://opencode.ai/docs/providers#gitlab-duo)
GitLab Duo предоставляет агентский чат на базе искусственного интеллекта со встроенными возможностями вызова инструментов через прокси-сервер GitLab Anthropic.
  1. Запустите команду `/connect` и выберите GitLab.
```

/connect

```

  2. Выберите метод аутентификации:
```

┌ Select auth method


│


│ OAuth (Recommended)


│ Personal Access Token


└

```

#### [Использование OAuth (рекомендуется)](https://opencode.ai/docs/providers#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-oauth-%D1%80%D0%B5%D0%BA%D0%BE%D0%BC%D0%B5%D0%BD%D0%B4%D1%83%D0%B5%D1%82%D1%81%D1%8F)
Выберите **OAuth** , и ваш браузер откроется для авторизации.
#### [Использование токена личного доступа](https://opencode.ai/docs/providers#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-%D1%82%D0%BE%D0%BA%D0%B5%D0%BD%D0%B0-%D0%BB%D0%B8%D1%87%D0%BD%D0%BE%D0%B3%D0%BE-%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF%D0%B0)
    1. Перейдите в [Настройки пользователя GitLab > Токены доступа](https://gitlab.com/-/user_settings/personal_access_tokens).
    2. Нажмите **Добавить новый токен**.
    3. Имя: `OpenCode`, Области применения: `api`
    4. Скопируйте токен (начинается с `glpat-`)
    5. Введите его в терминал
  3. Запустите команду `/models`, чтобы просмотреть доступные модели.
```

/models

```

Доступны три модели на основе Claude:
     * **duo-chat-haiku-4-5** (по умолчанию) — быстрые ответы на быстрые задачи.
     * **duo-chat-sonnet-4-5** — сбалансированная производительность для большинства рабочих процессов.
     * **duo-chat-opus-4-5** — Наиболее способен к комплексному анализу.


Вы также можете указать переменную среды «GITLAB_TOKEN», если не хотите. для хранения токена в хранилище аутентификации opencode.
##### [Самостоятельная GitLab](https://opencode.ai/docs/providers#%D1%81%D0%B0%D0%BC%D0%BE%D1%81%D1%82%D0%BE%D1%8F%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%B0%D1%8F-gitlab)
opencode использует небольшую модель для некоторых задач ИИ, таких как создание заголовка сеанса. По умолчанию он настроен на использование gpt-5-nano, размещенного на Zen. Чтобы заблокировать opencode чтобы использовать только свой собственный экземпляр, размещенный на GitLab, добавьте следующее в свой `opencode.json` файл. Также рекомендуется отключить совместное использование сеансов.
```

{



"$schema": "https://opencode.ai/config.json",




"small_model": "gitlab/duo-chat-haiku-4-5",




"share": "disabled"



}

```

Для самостоятельных экземпляров GitLab:
Окно терминала```


export GITLAB_INSTANCE_URL=https://gitlab.company.com




export GITLAB_TOKEN=glpat-...


```

Если в вашем экземпляре используется собственный AI-шлюз:
Окно терминала```


GITLAB_AI_GATEWAY_URL=https://ai-gateway.company.com


```

Или добавьте в свой профиль bash:
~/.bash_profile```


export GITLAB_INSTANCE_URL=https://gitlab.company.com




export GITLAB_AI_GATEWAY_URL=https://ai-gateway.company.com




export GITLAB_TOKEN=glpat-...


```

Ваш администратор GitLab должен включить следующее:
  1. [Платформа Duo Agent](https://docs.gitlab.com/user/gitlab_duo/turn_on_off/) для пользователя, группы или экземпляра
  2. Флаги функций (через консоль Rails): 
     * `agent_platform_claude_code`
     * `third_party_agents_enabled`


##### [OAuth для локальных экземпляров](https://opencode.ai/docs/providers#oauth-%D0%B4%D0%BB%D1%8F-%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D1%85-%D1%8D%D0%BA%D0%B7%D0%B5%D0%BC%D0%BF%D0%BB%D1%8F%D1%80%D0%BE%D0%B2)
Чтобы Oauth работал на вашем локальном экземпляре, вам необходимо создать новое приложение (Настройки → Приложения) с URL обратного вызова `http://127.0.0.1:8080/callback` и следующие области:
  * API (Доступ к API от вашего имени)
  * read_user (прочитать вашу личную информацию)
  * read_repository (разрешает доступ к репозиторию только для чтения)


Затем укажите идентификатор приложения как переменную среды:
Окно терминала```


export GITLAB_OAUTH_CLIENT_ID=your_application_id_here


```

Дополнительная документация на домашней странице [opencode-gitlab-auth](https://www.npmjs.com/package/@gitlab/opencode-gitlab-auth).
##### [Конфигурация](https://opencode.ai/docs/providers#%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F)
Настройте через `opencode.json`:
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"gitlab": {




"options": {




"instanceUrl": "https://gitlab.com",




"featureFlags": {




"duo_agent_platform_agentic_chat": true,




"duo_agent_platform": true



}


}


}


}


}

```

##### [Инструменты API GitLab (необязательно, но настоятельно рекомендуется)](https://opencode.ai/docs/providers#%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B-api-gitlab-%D0%BD%D0%B5%D0%BE%D0%B1%D1%8F%D0%B7%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%BE-%D0%BD%D0%BE-%D0%BD%D0%B0%D1%81%D1%82%D0%BE%D1%8F%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%BE-%D1%80%D0%B5%D0%BA%D0%BE%D0%BC%D0%B5%D0%BD%D0%B4%D1%83%D0%B5%D1%82%D1%81%D1%8F)
Чтобы получить доступ к инструментам GitLab (мерж-реквесты, задачи, конвейеры, CI/CD и т. д.):
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"plugin": ["@gitlab/opencode-gitlab-plugin"]



}

```

Этот плагин предоставляет комплексные возможности управления репозиторием GitLab, включая проверки MR, отслеживание проблем, мониторинг конвейера и многое другое.
* * *

### [GitHub Copilot](https://opencode.ai/docs/providers#github-copilot)
Чтобы использовать подписку GitHub Copilot с открытым кодом:
Некоторым моделям может потребоваться [Pro+ подписка](https://github.com/features/copilot/plans) для использования.
Некоторые модели необходимо включить вручную в настройках [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/use-ai-models/configure-access-to-ai-models#setup-for-individual-use).
  1. Запустите команду `/connect` и найдите GitHub Copilot.
```

/connect

```

  2. Перейдите на [github.com/login/device](https://github.com/login/device) и введите код.
```

┌ Login with GitHub Copilot


│


│ https://github.com/login/device


│


│ Enter code: 8F43-6FCF


│


└ Waiting for authorization...

```

  3. Теперь запустите команду `/models`, чтобы выбрать нужную модель.
```

/models

```



* * *

### [Google Vertex AI](https://opencode.ai/docs/providers#google-vertex-ai)
Чтобы использовать Google Vertex AI с opencode:
  1. Перейдите в **Model Garden** в Google Cloud Console и проверьте модели, доступные в вашем регионе.
Вам необходим проект Google Cloud с включенным Vertex AI API.
  2. Установите необходимые переменные среды:
     * `GOOGLE_CLOUD_PROJECT`: идентификатор вашего проекта Google Cloud.
     * `VERTEX_LOCATION` (необязательно): регион для Vertex AI (по умолчанию `global`).
     * Аутентификация (выберите одну): 
       * `GOOGLE_APPLICATION_CREDENTIALS`: путь к ключевому файлу JSON вашего сервисного аккаунта.
       * Аутентификация через CLI gcloud: `gcloud auth application-default login`.
Установите их во время запуска opencode.
Окно терминала```


GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json GOOGLE_CLOUD_PROJECT=your-project-idopencode


```

Или добавьте их в свой профиль bash.
~/.bash_profile```


export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json




export GOOGLE_CLOUD_PROJECT=your-project-id




export VERTEX_LOCATION=global


```



Регион `global` повышает доступность и уменьшает количество ошибок без дополнительных затрат. Используйте региональные конечные точки (например, `us-central1`) для требований к местонахождению данных. [Подробнее](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-partner-models#regional_and_global_endpoints)
  1. Запустите команду `/models`, чтобы выбрать нужную модель.
```

/models

```



* * *

### [Groq](https://opencode.ai/docs/providers#groq)
  1. Перейдите в консоль Groq](<https://console.groq.com/>), нажмите **Создать ключ API** и скопируйте ключ.
  2. Запустите команду `/connect` и найдите Groq.
```

/connect

```

  3. Введите ключ API для провайдера.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать тот, который вам нужен.
```

/models

```



* * *

### [Hugging Face](https://opencode.ai/docs/providers#hugging-face)
[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) предоставляют доступ к открытым моделям, поддерживаемым более чем 17 поставщиками.
  1. Перейдите в [Настройки Hugging Face](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained), чтобы создать токен с разрешением совершать вызовы к поставщикам выводов.
  2. Запустите команду `/connect` и найдите **Hugging Face**.
```

/connect

```

  3. Введите свой токен Hugging Face.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Kimi-K2-Instruct_ или _GLM-4.6_.
```

/models

```



* * *

### [Helicone](https://opencode.ai/docs/providers#helicone)
[Helicone](https://helicone.ai) — это платформа наблюдения LLM, которая обеспечивает ведение журнала, мониторинг и аналитику для ваших приложений искусственного интеллекта. Helicone AI Gateway автоматически направляет ваши запросы соответствующему поставщику на основе модели.
  1. Перейдите в [Helicone](https://helicone.ai), создайте учетную запись и сгенерируйте ключ API на своей панели управления.
  2. Запустите команду `/connect` и найдите **Helicone**.
```

/connect

```

  3. Введите свой ключ API Helicone.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



Дополнительные сведения о дополнительных провайдерах и расширенных функциях, таких как кэширование и ограничение скорости, см. в [Документация Helicone](https://docs.helicone.ai).
#### [Дополнительные конфигурации](https://opencode.ai/docs/providers#%D0%B4%D0%BE%D0%BF%D0%BE%D0%BB%D0%BD%D0%B8%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D1%8B%D0%B5-%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D0%B8)
Если вы видите функцию или модель от Helicone, которая не настраивается автоматически через opencode, вы всегда можете настроить ее самостоятельно.
Вот [Справочник моделей Helicone](https://helicone.ai/models), он понадобится вам, чтобы получить идентификаторы моделей, которые вы хотите добавить.
~/.config/opencode/opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"helicone": {




"npm": "@ai-sdk/openai-compatible",




"name": "Helicone",




"options": {




"baseURL": "https://ai-gateway.helicone.ai",



},



"models": {




"gpt-4o": {



// Model ID (from Helicone's model directory page)



"name": "GPT-4o", // Your own custom name for the model



},



"claude-sonnet-4-20250514": {




"name": "Claude Sonnet 4",



},


},


},


},


}

```

#### [Пользовательские заголовки](https://opencode.ai/docs/providers#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-%D0%B7%D0%B0%D0%B3%D0%BE%D0%BB%D0%BE%D0%B2%D0%BA%D0%B8)
Helicone поддерживает пользовательские заголовки для таких функций, как кэширование, отслеживание пользователей и управление сеансами. Добавьте их в конфигурацию вашего провайдера, используя `options.headers`:
~/.config/opencode/opencode.jsonc```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"helicone": {




"npm": "@ai-sdk/openai-compatible",




"name": "Helicone",




"options": {




"baseURL": "https://ai-gateway.helicone.ai",




"headers": {




"Helicone-Cache-Enabled": "true",




"Helicone-User-Id": "opencode",



},


},


},


},


}

```

##### [Отслеживание сеансов](https://opencode.ai/docs/providers#%D0%BE%D1%82%D1%81%D0%BB%D0%B5%D0%B6%D0%B8%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-%D1%81%D0%B5%D0%B0%D0%BD%D1%81%D0%BE%D0%B2)
Функция Helicone [Sessions](https://docs.helicone.ai/features/sessions) позволяет группировать связанные запросы LLM вместе. Используйте плагин [opencode-helicone-session](https://github.com/H2Shami/opencode-helicone-session), чтобы автоматически регистрировать каждый диалог opencode как сеанс в Helicone.
Окно терминала```


npminstall-gopencode-helicone-session


```

Добавьте его в свою конфигурацию.
opencode.json```

{



"plugin": ["opencode-helicone-session"]



}

```

Плагин вставляет в ваши запросы заголовки `Helicone-Session-Id` и `Helicone-Session-Name`. На странице «Сеансы» Helicone вы увидите каждый диалог opencode, указанный как отдельный сеанс.
##### [Общие разъемы Helicone](https://opencode.ai/docs/providers#%D0%BE%D0%B1%D1%89%D0%B8%D0%B5-%D1%80%D0%B0%D0%B7%D1%8A%D0%B5%D0%BC%D1%8B-helicone)
Заголовок | Описание  
---|---  
`Helicone-Cache-Enabled` | Включить кэширование ответов (`true`/`false`)  
`Helicone-User-Id` | Отслеживание показателей по пользователю  
`Helicone-Property-[Name]` | Добавьте пользовательские свойства (например, `Helicone-Property-Environment`)  
`Helicone-Prompt-Id` | Связывание запросов с версиями промптов  
См. [Справочник заголовков Helicone](https://docs.helicone.ai/helicone-headers/header-directory) для всех доступных заголовков.
* * *

### [llama.cpp](https://opencode.ai/docs/providers#llamacpp)
Вы можете настроить opencode для использования локальных моделей с помощью [утилиты llama-server llama.cpp’s](https://github.com/ggml-org/llama.cpp)
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"llama.cpp": {




"npm": "@ai-sdk/openai-compatible",




"name": "llama-server (local)",




"options": {




"baseURL": "http://127.0.0.1:8080/v1"



},



"models": {




"qwen3-coder:a3b": {




"name": "Qwen3-Coder: a3b-30b (local)",




"limit": {




"context": 128000,




"output": 65536



}


}


}


}


}


}

```

В этом примере:
  * `llama.cpp` — это идентификатор пользовательского поставщика. Это может быть любая строка, которую вы хотите.
  * `npm` указывает пакет, который будет использоваться для этого поставщика. Здесь `@ai-sdk/openai-compatible` используется для любого API-интерфейса, совместимого с OpenAI.
  * `name` — это отображаемое имя поставщика в пользовательском интерфейсе.
  * `options.baseURL` — конечная точка локального сервера.
  * `models` — это карта идентификаторов моделей с их конфигурациями. Название модели будет отображаться в списке выбора модели.


* * *

### [IO.NET](https://opencode.ai/docs/providers#ionet)
IO.NET предлагает 17 моделей, оптимизированных для различных случаев использования:
  1. Перейдите в консоль IO.NET](<https://ai.io.net/>), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **IO.NET**.
```

/connect

```

  3. Введите свой ключ API IO.NET.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



* * *

### [LM Studio](https://opencode.ai/docs/providers#lm-studio)
Вы можете настроить opencode для использования локальных моделей через LM Studio.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"lmstudio": {




"npm": "@ai-sdk/openai-compatible",




"name": "LM Studio (local)",




"options": {




"baseURL": "http://127.0.0.1:1234/v1"



},



"models": {




"google/gemma-3n-e4b": {




"name": "Gemma 3n-e4b (local)"



}


}


}


}


}

```

В этом примере:
  * `lmstudio` — это идентификатор пользовательского поставщика. Это может быть любая строка, которую вы хотите.
  * `npm` указывает пакет, который будет использоваться для этого поставщика. Здесь `@ai-sdk/openai-compatible` используется для любого API-интерфейса, совместимого с OpenAI.
  * `name` — это отображаемое имя поставщика в пользовательском интерфейсе.
  * `options.baseURL` — конечная точка локального сервера.
  * `models` — это карта идентификаторов моделей с их конфигурациями. Название модели будет отображаться в списке выбора модели.


* * *

### [Moonshot AI](https://opencode.ai/docs/providers#moonshot-ai)
Чтобы использовать Кими К2 из Moonshot AI:
  1. Перейдите в [консоль Moonshot AI](https://platform.moonshot.ai/console), создайте учетную запись и нажмите **Создать ключ API**.
  2. Запустите команду `/connect` и найдите **Moonshot AI**.
```

/connect

```

  3. Введите свой API-ключ Moonshot.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать _Kimi K2_.
```

/models

```



* * *

### [MiniMax](https://opencode.ai/docs/providers#minimax)
  1. Перейдите в [консоль API MiniMax](https://platform.minimax.io/login), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **MiniMax**.
```

/connect

```

  3. Введите свой ключ API MiniMax.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель типа _M2.1_.
```

/models

```



* * *

### [Nebius Token Factory](https://opencode.ai/docs/providers#nebius-token-factory)
  1. Перейдите в консоль Nebius Token Factory](<https://tokenfactory.nebius.com/>), создайте учетную запись и нажмите **Добавить ключ**.
  2. Запустите команду `/connect` и найдите **Nebius Token Factory**.
```

/connect

```

  3. Введите ключ API фабрики токенов Nebius.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Kimi K2 Instruct_.
```

/models

```



* * *

### [Ollama](https://opencode.ai/docs/providers#ollama)
Вы можете настроить opencode для использования локальных моделей через Ollama.
Ollama может автоматически настроиться для opencode. Подробности см. в документации по интеграции Ollama](<https://docs.ollama.com/integrations/opencode>).
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"ollama": {




"npm": "@ai-sdk/openai-compatible",




"name": "Ollama (local)",




"options": {




"baseURL": "http://localhost:11434/v1"



},



"models": {




"llama2": {




"name": "Llama 2"



}


}


}


}


}

```

В этом примере:
  * `ollama` — это идентификатор пользовательского поставщика. Это может быть любая строка, которую вы хотите.
  * `npm` указывает пакет, который будет использоваться для этого поставщика. Здесь `@ai-sdk/openai-compatible` используется для любого API-интерфейса, совместимого с OpenAI.
  * `name` — это отображаемое имя поставщика в пользовательском интерфейсе.
  * `options.baseURL` — конечная точка локального сервера.
  * `models` — это карта идентификаторов моделей с их конфигурациями. Название модели будет отображаться в списке выбора модели.


Если вызовы инструментов не работают, попробуйте увеличить `num_ctx` в Олламе. Начните с 16–32 тысяч.
* * *

### [Ollama Cloud](https://opencode.ai/docs/providers#ollama-cloud)
Чтобы использовать Ollama Cloud с opencode:
  1. Перейдите на <https://ollama.com/> и войдите в систему или создайте учетную запись.
  2. Перейдите в **Настройки** > **Ключи** и нажмите **Добавить ключ API** , чтобы создать новый ключ API.
  3. Скопируйте ключ API для использования в opencode.
  4. Запустите команду `/connect` и найдите **Ollama Cloud**.
```

/connect

```

  5. Введите свой ключ API Ollama Cloud.
```

┌ API key


│


│


└ enter

```

  6. **Важно**. Перед использованием облачных моделей в opencode необходимо получить информацию о модели локально:
Окно терминала```


ollamapullgpt-oss:20b-cloud


```

  7. Запустите команду `/models`, чтобы выбрать модель облака Ollama.
```

/models

```



* * *

### [OpenAI](https://opencode.ai/docs/providers#openai)
Мы рекомендуем подписаться на [ChatGPT Plus или Pro](https://chatgpt.com/pricing).
  1. После регистрации выполните команду `/connect` и выберите OpenAI.
```

/connect

```

  2. Здесь вы можете выбрать опцию **ChatGPT Plus/Pro** , и ваш браузер откроется. и попросите вас пройти аутентификацию.
```

┌ Select auth method


│


│ ChatGPT Plus/Pro


│ Manually enter API Key


└

```

  3. Теперь все модели OpenAI должны быть доступны при использовании команды `/models`.
```

/models

```



##### [Использование ключей API](https://opencode.ai/docs/providers#%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%B9-api-1)
Если у вас уже есть ключ API, вы можете выбрать **Ввести ключ API вручную** и вставить его в свой терминал.
* * *

### [OpenCode Zen](https://opencode.ai/docs/providers#opencode-zen-1)
OpenCode Zen — это список протестированных и проверенных моделей, предоставленный командой opencode. [Подробнее](https://opencode.ai/docs/zen).
  1. Войдите в систему **[OpenCode Zen](https://opencode.ai/auth)** и нажмите **Создать ключ API**.
  2. Запустите команду `/connect` и найдите **OpenCode Zen**.
```

/connect

```

  3. Введите свой ключ API opencode.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Qwen 3 Coder 480B_.
```

/models

```



* * *

### [OpenRouter](https://opencode.ai/docs/providers#openrouter)
  1. Перейдите на панель управления OpenRouter](<https://openrouter.ai/settings/keys>), нажмите **Создать ключ API** и скопируйте ключ.
  2. Запустите команду `/connect` и найдите OpenRouter.
```

/connect

```

  3. Введите ключ API для провайдера.
```

┌ API key


│


│


└ enter

```

  4. Многие модели OpenRouter предварительно загружены по умолчанию. Запустите команду `/models`, чтобы выбрать нужную.
```

/models

```

Вы также можете добавить дополнительные модели через конфигурацию opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"openrouter": {




"models": {




"somecoolnewmodel": {}



}


}


}


}

```

  5. Вы также можете настроить их через конфигурацию opencode. Вот пример указания провайдера
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"openrouter": {




"models": {




"moonshotai/kimi-k2": {




"options": {




"provider": {




"order": ["baseten"],




"allow_fallbacks": false



}


}


}


}


}


}


}

```



* * *

### [SAP AI Core](https://opencode.ai/docs/providers#sap-ai-core)
SAP AI Core предоставляет доступ к более чем 40 моделям от OpenAI, Anthropic, Google, Amazon, Meta, Mistral и AI21 через единую платформу.
  1. Перейдите в [SAP BTP Cockpit](https://account.hana.ondemand.com/), перейдите к экземпляру службы SAP AI Core и создайте ключ службы.
Ключ службы — это объект JSON, содержащий `clientid`, `clientsecret`, `url` и `serviceurls.AI_API_URL`. Экземпляр AI Core можно найти в разделе **Сервисы** > **Экземпляры и подписки** в панели управления BTP.
  2. Запустите команду `/connect` и найдите **SAP AI Core**.
```

/connect

```

  3. Введите свой сервисный ключ в формате JSON.
```

┌ Service key


│


│


└ enter

```

Или установите переменную среды `AICORE_SERVICE_KEY`:
Окно терминала```


AICORE_SERVICE_KEY='{"clientid":"...","clientsecret":"...","url":"...","serviceurls":{"AI_API_URL":"..."}}'opencode


```

Или добавьте его в свой профиль bash:
~/.bash_profile```


export AICORE_SERVICE_KEY='{"clientid":"...","clientsecret":"...","url":"...","serviceurls":{"AI_API_URL":"..."}}'


```

  4. При необходимости укажите идентификатор развертывания и группу ресурсов:
Окно терминала```


AICORE_DEPLOYMENT_ID=your-deployment-id AICORE_RESOURCE_GROUP=your-resource-groupopencode


```

Эти параметры являются необязательными и должны быть настроены в соответствии с настройками SAP AI Core.
  5. Запустите команду `/models`, чтобы выбрать одну из более чем 40 доступных моделей.
```

/models

```



* * *

### [OVHcloud AI Endpoints](https://opencode.ai/docs/providers#ovhcloud-ai-endpoints)
  1. Перейдите к [OVHcloud Panel](https://ovh.com/manager). Перейдите в раздел `Public Cloud`, `AI & Machine Learning` > `AI Endpoints` и на вкладке `API Keys` нажмите **Создать новый ключ API**.
  2. Запустите команду `/connect` и найдите **Конечные точки OVHcloud AI**.
```

/connect

```

  3. Введите ключ API конечных точек OVHcloud AI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель типа _gpt-oss-120b_.
```

/models

```



* * *

### [Scaleway](https://opencode.ai/docs/providers#scaleway)
Чтобы использовать [Scaleway Generative APIs](https://www.scaleway.com/en/docs/generative-apis/) с opencode:
  1. Перейдите к [Настройки IAM консоли Scaleway](https://console.scaleway.com/iam/api-keys), чтобы сгенерировать новый ключ API.
  2. Запустите команду `/connect` и найдите **Scaleway**.
```

/connect

```

  3. Введите ключ API Scaleway.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель, например _devstral-2-123b-instruct-2512_ или _gpt-oss-120b_.
```

/models

```



* * *

### [Together AI](https://opencode.ai/docs/providers#together-ai)
  1. Перейдите в [консоль Together AI](https://api.together.ai), создайте учетную запись и нажмите **Добавить ключ**.
  2. Запустите команду `/connect` и найдите **Together AI**.
```

/connect

```

  3. Введите ключ API Together AI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Kimi K2 Instruct_.
```

/models

```



* * *

### [Venice AI](https://opencode.ai/docs/providers#venice-ai)
  1. Перейдите к [консоли Venice AI](https://venice.ai), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **Venice AI**.
```

/connect

```

  3. Введите свой ключ API Venice AI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель типа _Llama 3.3 70B_.
```

/models

```



* * *

### [Vercel AI Gateway](https://opencode.ai/docs/providers#vercel-ai-gateway)
Vercel AI Gateway позволяет получать доступ к моделям OpenAI, Anthropic, Google, xAI и других источников через единую конечную точку. Модели предлагаются по прейскурантной цене без наценок.
  1. Перейдите на [панель мониторинга Vercel](https://vercel.com/), перейдите на вкладку **AI Gateway** и нажмите **Ключи API** , чтобы создать новый ключ API.
  2. Запустите команду `/connect` и найдите **Vercel AI Gateway**.
```

/connect

```

  3. Введите ключ API Vercel AI Gateway.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель.
```

/models

```



Вы также можете настраивать модели через конфигурацию opencode. Ниже приведен пример указания порядка маршрутизации поставщика.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"vercel": {




"models": {




"anthropic/claude-sonnet-4": {




"options": {




"order": ["anthropic", "vertex"]



}


}


}


}


}


}

```

Некоторые полезные параметры маршрутизации:
Вариант | Описание  
---|---  
`order` | Последовательность провайдеров для попытки  
`only` | Ограничить конкретными провайдерами  
`zeroDataRetention` | Использовать только провайдеров с политикой нулевого хранения данных  
* * *

### [xAI](https://opencode.ai/docs/providers#xai)
  1. Перейдите на [консоль xAI](https://console.x.ai/), создайте учетную запись и сгенерируйте ключ API.
  2. Запустите команду `/connect` и найдите **xAI**.
```

/connect

```

  3. Введите свой ключ API xAI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать такую ​​модель, как _Grok Beta_.
```

/models

```



* * *

### [Z.AI](https://opencode.ai/docs/providers#zai)
  1. Перейдите в [консоль Z.AI API](https://z.ai/manage-apikey/apikey-list), создайте учетную запись и нажмите **Создать новый ключ API**.
  2. Запустите команду `/connect` и найдите **Z.AI**.
```

/connect

```

Если вы подписаны на **План кодирования GLM** , выберите **План кодирования Z.AI**.
  3. Введите свой ключ API Z.AI.
```

┌ API key


│


│


└ enter

```

  4. Запустите команду `/models`, чтобы выбрать модель типа _GLM-4.7_.
```

/models

```



* * *

### [ZenMux](https://opencode.ai/docs/providers#zenmux)
  1. Перейдите на [панель управления ZenMux](https://zenmux.ai/settings/keys), нажмите **Создать ключ API** и скопируйте ключ.
  2. Запустите команду `/connect` и найдите ZenMux.
```

/connect

```

  3. Введите ключ API для провайдера.
```

┌ API key


│


│


└ enter

```

  4. Многие модели ZenMux предварительно загружены по умолчанию. Запустите команду `/models`, чтобы выбрать нужную.
```

/models

```

Вы также можете добавить дополнительные модели через конфигурацию opencode.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"zenmux": {




"models": {




"somecoolnewmodel": {}



}


}


}


}

```



* * *

