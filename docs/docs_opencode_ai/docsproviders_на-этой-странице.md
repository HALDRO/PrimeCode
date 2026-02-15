<!-- Source: https://opencode.ai/docs/providers -->

## На этой странице
  * [ Обзор ](https://opencode.ai/docs/providers#_top)
    * [ Учетные данные ](https://opencode.ai/docs/providers#%D1%83%D1%87%D0%B5%D1%82%D0%BD%D1%8B%D0%B5-%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5)
    * [ Настройка ](https://opencode.ai/docs/providers#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
  * [ OpenCode Zen ](https://opencode.ai/docs/providers#opencode-zen)
  * [ Каталог ](https://opencode.ai/docs/providers#%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3)
    * [ 302.AI ](https://opencode.ai/docs/providers#302ai)
    * [ Amazon Bedrock ](https://opencode.ai/docs/providers#amazon-bedrock)
    * [ Anthropic ](https://opencode.ai/docs/providers#anthropic)
    * [ Azure OpenAI ](https://opencode.ai/docs/providers#azure-openai)
    * [ Azure Cognitive Services ](https://opencode.ai/docs/providers#azure-cognitive-services)
    * [ Baseten ](https://opencode.ai/docs/providers#baseten)
    * [ Cerebras ](https://opencode.ai/docs/providers#cerebras)
    * [ Cloudflare AI Gateway ](https://opencode.ai/docs/providers#cloudflare-ai-gateway)
    * [ Cortecs ](https://opencode.ai/docs/providers#cortecs)
    * [ DeepSeek ](https://opencode.ai/docs/providers#deepseek)
    * [ Deep Infra ](https://opencode.ai/docs/providers#deep-infra)
    * [ Firmware ](https://opencode.ai/docs/providers#firmware)
    * [ Fireworks AI ](https://opencode.ai/docs/providers#fireworks-ai)
    * [ GitLab Duo ](https://opencode.ai/docs/providers#gitlab-duo)
    * [ GitHub Copilot ](https://opencode.ai/docs/providers#github-copilot)
    * [ Google Vertex AI ](https://opencode.ai/docs/providers#google-vertex-ai)
    * [ Groq ](https://opencode.ai/docs/providers#groq)
    * [ Hugging Face ](https://opencode.ai/docs/providers#hugging-face)
    * [ Helicone ](https://opencode.ai/docs/providers#helicone)
    * [ llama.cpp ](https://opencode.ai/docs/providers#llamacpp)
    * [ IO.NET ](https://opencode.ai/docs/providers#ionet)
    * [ LM Studio ](https://opencode.ai/docs/providers#lm-studio)
    * [ Moonshot AI ](https://opencode.ai/docs/providers#moonshot-ai)
    * [ MiniMax ](https://opencode.ai/docs/providers#minimax)
    * [ Nebius Token Factory ](https://opencode.ai/docs/providers#nebius-token-factory)
    * [ Ollama ](https://opencode.ai/docs/providers#ollama)
    * [ Ollama Cloud ](https://opencode.ai/docs/providers#ollama-cloud)
    * [ OpenAI ](https://opencode.ai/docs/providers#openai)
    * [ OpenCode Zen ](https://opencode.ai/docs/providers#opencode-zen-1)
    * [ OpenRouter ](https://opencode.ai/docs/providers#openrouter)
    * [ SAP AI Core ](https://opencode.ai/docs/providers#sap-ai-core)
    * [ OVHcloud AI Endpoints ](https://opencode.ai/docs/providers#ovhcloud-ai-endpoints)
    * [ Scaleway ](https://opencode.ai/docs/providers#scaleway)
    * [ Together AI ](https://opencode.ai/docs/providers#together-ai)
    * [ Venice AI ](https://opencode.ai/docs/providers#venice-ai)
    * [ Vercel AI Gateway ](https://opencode.ai/docs/providers#vercel-ai-gateway)
    * [ xAI ](https://opencode.ai/docs/providers#xai)
    * [ Z.AI ](https://opencode.ai/docs/providers#zai)
    * [ ZenMux ](https://opencode.ai/docs/providers#zenmux)
  * [ Пользовательский поставщик ](https://opencode.ai/docs/providers#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B9-%D0%BF%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA)
  * [ Поиск неисправностей ](https://opencode.ai/docs/providers#%D0%BF%D0%BE%D0%B8%D1%81%D0%BA-%D0%BD%D0%B5%D0%B8%D1%81%D0%BF%D1%80%D0%B0%D0%B2%D0%BD%D0%BE%D1%81%D1%82%D0%B5%D0%B9)

### [Учетные данные](https://opencode.ai/docs/providers#%D1%83%D1%87%D0%B5%D1%82%D0%BD%D1%8B%D0%B5-%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5)
Когда вы добавляете ключи API провайдера с помощью команды `/connect`, они сохраняются в `~/.local/share/opencode/auth.json`.
* * *

### [Настройка](https://opencode.ai/docs/providers#%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0)
Вы можете настроить поставщиков через раздел `provider` в вашем opencode. конфиг.
* * *
#### [Базовый URL](https://opencode.ai/docs/providers#%D0%B1%D0%B0%D0%B7%D0%BE%D0%B2%D1%8B%D0%B9-url)
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

