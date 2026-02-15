<!-- Source: https://opencode.ai/docs/ru/providers -->

## На этой странице
  * [ Обзор ](https://opencode.ai/docs/ru/providers#_top)
    * [ Учетные данные ](https://opencode.ai/docs/ru/providers#%D1%83%D1%87%D0%B5%D1%82%D0%BD%D1%8B%D0%B5-%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5)
    * [ Настройка ](https://opencode.ai/docs/ru/providers#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
  * [ OpenCode Zen ](https://opencode.ai/docs/ru/providers#opencode-zen)
  * [ Каталог ](https://opencode.ai/docs/ru/providers#%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3)
    * [ 302.AI ](https://opencode.ai/docs/ru/providers#302ai)
    * [ Amazon Bedrock ](https://opencode.ai/docs/ru/providers#amazon-bedrock)
    * [ Anthropic ](https://opencode.ai/docs/ru/providers#anthropic)
    * [ Azure OpenAI ](https://opencode.ai/docs/ru/providers#azure-openai)
    * [ Azure Cognitive Services ](https://opencode.ai/docs/ru/providers#azure-cognitive-services)
    * [ Baseten ](https://opencode.ai/docs/ru/providers#baseten)
    * [ Cerebras ](https://opencode.ai/docs/ru/providers#cerebras)
    * [ Cloudflare AI Gateway ](https://opencode.ai/docs/ru/providers#cloudflare-ai-gateway)
    * [ Cortecs ](https://opencode.ai/docs/ru/providers#cortecs)
    * [ DeepSeek ](https://opencode.ai/docs/ru/providers#deepseek)
    * [ Deep Infra ](https://opencode.ai/docs/ru/providers#deep-infra)
    * [ Firmware ](https://opencode.ai/docs/ru/providers#firmware)
    * [ Fireworks AI ](https://opencode.ai/docs/ru/providers#fireworks-ai)
    * [ GitLab Duo ](https://opencode.ai/docs/ru/providers#gitlab-duo)
    * [ GitHub Copilot ](https://opencode.ai/docs/ru/providers#github-copilot)
    * [ Google Vertex AI ](https://opencode.ai/docs/ru/providers#google-vertex-ai)
    * [ Groq ](https://opencode.ai/docs/ru/providers#groq)
    * [ Hugging Face ](https://opencode.ai/docs/ru/providers#hugging-face)
    * [ Helicone ](https://opencode.ai/docs/ru/providers#helicone)
    * [ llama.cpp ](https://opencode.ai/docs/ru/providers#llamacpp)
    * [ IO.NET ](https://opencode.ai/docs/ru/providers#ionet)
    * [ LM Studio ](https://opencode.ai/docs/ru/providers#lm-studio)
    * [ Moonshot AI ](https://opencode.ai/docs/ru/providers#moonshot-ai)
    * [ MiniMax ](https://opencode.ai/docs/ru/providers#minimax)
    * [ Nebius Token Factory ](https://opencode.ai/docs/ru/providers#nebius-token-factory)
    * [ Ollama ](https://opencode.ai/docs/ru/providers#ollama)
    * [ Ollama Cloud ](https://opencode.ai/docs/ru/providers#ollama-cloud)
    * [ OpenAI ](https://opencode.ai/docs/ru/providers#openai)
    * [ OpenCode Zen ](https://opencode.ai/docs/ru/providers#opencode-zen-1)
    * [ OpenRouter ](https://opencode.ai/docs/ru/providers#openrouter)
    * [ SAP AI Core ](https://opencode.ai/docs/ru/providers#sap-ai-core)
    * [ OVHcloud AI Endpoints ](https://opencode.ai/docs/ru/providers#ovhcloud-ai-endpoints)
    * [ Scaleway ](https://opencode.ai/docs/ru/providers#scaleway)
    * [ Together AI ](https://opencode.ai/docs/ru/providers#together-ai)
    * [ Venice AI ](https://opencode.ai/docs/ru/providers#venice-ai)
    * [ Vercel AI Gateway ](https://opencode.ai/docs/ru/providers#vercel-ai-gateway)
    * [ xAI ](https://opencode.ai/docs/ru/providers#xai)
    * [ Z.AI ](https://opencode.ai/docs/ru/providers#zai)
    * [ ZenMux ](https://opencode.ai/docs/ru/providers#zenmux)
  * [ Пользовательский поставщик ](https://opencode.ai/docs/ru/providers#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B9-%D0%BF%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA)
  * [ Поиск неисправностей ](https://opencode.ai/docs/ru/providers#%D0%BF%D0%BE%D0%B8%D1%81%D0%BA-%D0%BD%D0%B5%D0%B8%D1%81%D0%BF%D1%80%D0%B0%D0%B2%D0%BD%D0%BE%D1%81%D1%82%D0%B5%D0%B9)

### [Учетные данные](https://opencode.ai/docs/ru/providers#%D1%83%D1%87%D0%B5%D1%82%D0%BD%D1%8B%D0%B5-%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5)
Когда вы добавляете ключи API провайдера с помощью команды `/connect`, они сохраняются в `~/.local/share/opencode/auth.json`.
* * *

### [Настройка](https://opencode.ai/docs/ru/providers#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете настроить поставщиков через раздел `provider` в вашем opencode. конфиг.
* * *
#### [Базовый URL](https://opencode.ai/docs/ru/providers#%D0%B1%D0%B0%D0%B7%D0%BE%D0%B2%D1%8B%D0%B9-url)
Вы можете настроить базовый URL-адрес для любого провайдера, установив параметр `baseURL`. Это полезно при использовании прокси-сервисов или пользовательских конечных точек.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"provider": {




"anthropic": {




"options": {




"baseURL": "https://api.anthropic.com/v1"



}


}


}


}

```

* * *

