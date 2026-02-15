<!-- Source: https://opencode.ai/docs/ru/plugins -->

## Custom Context


Include any state that should persist across compaction:


- Current task status


- Important decisions made


- Files being actively worked on



`)



},


}


}

```

Хук `experimental.session.compacting` срабатывает до того, как LLM сгенерирует сводку для продолжения. Используйте его для внедрения контекста, специфичного для домена, который будет пропущен при запросе на сжатие по умолчанию.
Вы также можете полностью заменить запрос на уплотнение, установив `output.prompt`:
.opencode/plugins/custom-compaction.ts```


importtype { Plugin } from"@opencode-ai/plugin"




exportconstCustomCompactionPlugin:Plugin=async (ctx) => {




return {




"experimental.session.compacting": async (input, output) => {



// Replace the entire compaction prompt



output.prompt =`



You are generating a continuation prompt for a multi-agent swarm session.


Summarize:


1. The current task and its status


2. Which files are being modified and by whom


3. Any blockers or dependencies between agents


4. The next steps to complete the work


Format as a structured prompt that a new agent can use to resume work.


`


},


}


}

```

Если установлен `output.prompt`, он полностью заменяет приглашение на сжатие по умолчанию. Массив `output.context` в этом случае игнорируется.
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/plugins.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

