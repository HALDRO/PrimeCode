# Anthropic Claude - Streaming Messages Reference

## Обзор

При `"stream": true` ответ приходит через Server-Sent Events (SSE).

---

## Поток событий

1. `message_start` - содержит объект Message с пустым content
2. Серия content blocks:
   - `content_block_start` - начало блока
   - `content_block_delta` (один или более) - дельты контента
   - `content_block_stop` - конец блока
3. `message_delta` - изменения верхнего уровня (stop_reason, usage)
4. `message_stop` - конец сообщения

Также могут быть `ping` и `error` события.

---

## Формат SSE событий

```
event: <event_type>
data: <json_data>
```

---

## message_start

```json
event: message_start
data: {
  "type": "message_start",
  "message": {
    "id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY",
    "type": "message",
    "role": "assistant",
    "content": [],
    "model": "claude-sonnet-4-5-20250929",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 25,
      "output_tokens": 1
    }
  }
}
```

---

## content_block_start

### Для текста:

```json
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "text",
    "text": ""
  }
}
```

### Для tool_use:

```json
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "tool_use",
    "id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
    "name": "get_weather",
    "input": {}
  }
}
```

### Для thinking (extended thinking):

```json
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "thinking",
    "thinking": ""
  }
}
```

---

## content_block_delta

### text_delta:

```json
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "text_delta",
    "text": "Hello"
  }
}
```

### input_json_delta (для tool_use):

```json
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 1,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "{\"location\": \"San Fra"
  }
}
```

**Важно:** `partial_json` - это частичная JSON строка, которую нужно накапливать до `content_block_stop`.

### thinking_delta:

```json
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",
    "thinking": "Let me solve this step by step..."
  }
}
```

### signature_delta (для thinking):

```json
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "signature_delta",
    "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b3h..."
  }
}
```

---

## content_block_stop

```json
event: content_block_stop
data: {
  "type": "content_block_stop",
  "index": 0
}
```

---

## message_delta

```json
event: message_delta
data: {
  "type": "message_delta",
  "delta": {
    "stop_reason": "end_turn",
    "stop_sequence": null
  },
  "usage": {
    "output_tokens": 15
  }
}
```

**stop_reason значения:**
- `"end_turn"` - модель завершила ответ
- `"tool_use"` - модель хочет вызвать инструмент
- `"max_tokens"` - достигнут лимит токенов
- `"stop_sequence"` - встречена stop sequence

---

## message_stop

```json
event: message_stop
data: {
  "type": "message_stop"
}
```

---

## ping

```json
event: ping
data: {
  "type": "ping"
}
```

---

## error

```json
event: error
data: {
  "type": "error",
  "error": {
    "type": "overloaded_error",
    "message": "Overloaded"
  }
}
```

---

## Полный пример: Text Streaming

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_xxx", "type": "message", "role": "assistant", "content": [], "model": "claude-sonnet-4-5-20250929", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 15}}

event: message_stop
data: {"type": "message_stop"}
```

---

## Полный пример: Tool Use Streaming

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check the weather:"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"San Francisco, CA\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

---

## Типы Content Blocks

| type | Описание | delta type |
|------|----------|------------|
| `text` | Текстовый контент | `text_delta` |
| `tool_use` | Вызов инструмента | `input_json_delta` |
| `thinking` | Extended thinking | `thinking_delta`, `signature_delta` |

---

## Важные моменты для конвертера

1. **index** - идентифицирует content block в массиве content
2. **tool_use** начинается с `content_block_start` содержащим `id`, `name`, пустой `input`
3. **input_json_delta** содержит `partial_json` - частичный JSON для накопления
4. **content_block_stop** сигнализирует завершение блока - можно парсить накопленный JSON
5. **stop_reason: "tool_use"** в `message_delta` означает, что модель хочет вызвать инструмент
6. Несколько tool_use блоков имеют разные `index` значения
