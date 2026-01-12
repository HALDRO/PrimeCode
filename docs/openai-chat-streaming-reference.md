# OpenAI Chat Completions - Streaming Reference

## Типы для Chat Completions

```python
from openai.types.chat import (
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionMessage,
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCallUnion,
    ChatCompletionStreamOptions,
    ChatCompletionToolMessageParam,
    ChatCompletionAssistantMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionSystemMessageParam,
)
```

## Методы

```
POST /chat/completions -> ChatCompletion (или Stream<ChatCompletionChunk> при stream=true)
```

---

## Структура ChatCompletionChunk (streaming)

При `stream=true` возвращается поток SSE событий:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### ChatCompletionChunk структура:

```typescript
interface ChatCompletionChunk {
  id: string;                    // "chatcmpl-xxx"
  object: "chat.completion.chunk";
  created: number;               // Unix timestamp
  model: string;                 // "gpt-4", "gpt-3.5-turbo", etc.
  system_fingerprint?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant" | "user" | "system" | "tool";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;              // Только в первом чанке tool_call
        type?: "function";        // Только в первом чанке
        function?: {
          name?: string;          // Только в первом чанке
          arguments?: string;     // Частичный JSON, накапливается
        };
      }>;
      function_call?: {           // Deprecated
        name?: string;
        arguments?: string;
      };
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs?: object | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

---

## Tool Calls Streaming

### Первый чанк tool_call (содержит id, type, name):

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "index": 0,
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": ""
        }
      }]
    },
    "finish_reason": null
  }]
}
```

### Последующие чанки (только arguments delta):

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "function": {
          "arguments": "{\"location\":"
        }
      }]
    },
    "finish_reason": null
  }]
}
```

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "function": {
          "arguments": " \"San Francisco\"}"
        }
      }]
    },
    "finish_reason": null
  }]
}
```

### Финальный чанк:

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {},
    "finish_reason": "tool_calls"
  }]
}
```

---

## Множественные Tool Calls

При нескольких tool_calls используется `index` для идентификации:

```json
{
  "choices": [{
    "delta": {
      "tool_calls": [
        {"index": 0, "id": "call_1", "type": "function", "function": {"name": "func1", "arguments": ""}},
        {"index": 1, "id": "call_2", "type": "function", "function": {"name": "func2", "arguments": ""}}
      ]
    }
  }]
}
```

Последующие дельты приходят с соответствующим `index`:

```json
{"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"a\":"}}]}}]}
{"choices": [{"delta": {"tool_calls": [{"index": 1, "function": {"arguments": "{\"b\":"}}]}}]}
```

---

## Важные моменты для конвертера

1. **id, type, name** - только в первом чанке для каждого tool_call
2. **arguments** - накапливается из всех чанков (partial JSON)
3. **index** - идентифицирует tool_call при множественных вызовах
4. **finish_reason: "tool_calls"** - сигнализирует завершение с tool calls
5. **[DONE]** - конец потока
