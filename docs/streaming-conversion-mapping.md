# OpenAI ↔ Claude Streaming Conversion Reference

## Маппинг событий

| OpenAI (Chat Completions) | Claude (Messages) | Примечания |
|---------------------------|-------------------|------------|
| Первый chunk с `role: "assistant"` | `message_start` | Claude отправляет полный Message объект |
| chunk с `content` | `content_block_start` (type: text) + `content_block_delta` (text_delta) | Claude разделяет на start/delta/stop |
| chunk с `tool_calls[].id/name` (первый) | `content_block_start` (type: tool_use) | Claude: id, name в content_block |
| chunk с `tool_calls[].arguments` | `content_block_delta` (input_json_delta) | OpenAI: `arguments`, Claude: `partial_json` |
| chunk с `finish_reason` | `message_delta` + `message_stop` | Claude разделяет на два события |
| `[DONE]` | `message_stop` | Конец потока |

---

## Конвертация OpenAI → Claude

### 1. Первый chunk (role: assistant)

**OpenAI:**
```json
{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}
```

**Claude:**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":1}}}
```

### 2. Text content

**OpenAI:**
```json
{"choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}
```

**Claude (если первый текст - нужен content_block_start):**
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
```

**Claude (последующий текст - только delta):**
```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}
```

### 3. Tool call start

**OpenAI:**
```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}
```

**Claude:**
```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_xxx","name":"get_weather","input":{}}}
```

### 4. Tool call arguments

**OpenAI:**
```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"location\":"}}]},"finish_reason":null}]}
```

**Claude:**
```
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}
```

### 5. Finish with tool_calls

**OpenAI:**
```json
{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}
```

**Claude:**
```
event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

### 6. Finish with stop

**OpenAI:**
```json
{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}
```

**Claude:**
```
event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

---

## Конвертация Claude → OpenAI

### 1. message_start

**Claude:**
```json
{"type":"message_start","message":{"id":"msg_xxx","role":"assistant","content":[],"model":"claude-3"}}
```

**OpenAI:**
```json
{"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"claude-3","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
```

### 2. content_block_start (text)

**Claude:**
```json
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
```

**OpenAI:** Ничего не отправляем (или пустой content delta)

### 3. content_block_delta (text_delta)

**Claude:**
```json
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
```

**OpenAI:**
```json
{"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
```

### 4. content_block_start (tool_use)

**Claude:**
```json
{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_xxx","name":"get_weather","input":{}}}
```

**OpenAI:**
```json
{"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_xxx","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}
```

### 5. content_block_delta (input_json_delta)

**Claude:**
```json
{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}
```

**OpenAI:**
```json
{"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"location\":"}}]},"finish_reason":null}]}
```

### 6. message_delta + message_stop

**Claude:**
```json
{"type":"message_delta","delta":{"stop_reason":"tool_use"}}
{"type":"message_stop"}
```

**OpenAI:**
```json
{"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
```
Затем: `data: [DONE]`

---

## Маппинг stop_reason / finish_reason

| Claude stop_reason | OpenAI finish_reason |
|--------------------|---------------------|
| `end_turn` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` |
| `stop_sequence` | `stop` |

---

## Маппинг tool_calls index

**OpenAI:** `tool_calls[].index` - индекс внутри массива tool_calls в одном chunk

**Claude:** `content_block.index` - индекс в массиве content всего сообщения

При конвертации нужно отслеживать:
- Какой Claude content block index соответствует какому OpenAI tool_call index
- Claude может иметь text блоки между tool_use блоками

---

## State Management для конвертера

```typescript
interface ConverterState {
  messageId: string;
  model: string;
  
  // Для OpenAI → Claude
  hasEmittedMessageStart: boolean;
  currentTextBlockIndex: number;
  activeToolCalls: Map<number, {  // OpenAI tool_call index → Claude block info
    blockIndex: number;
    id: string;
    name: string;
  }>;
  nextBlockIndex: number;
  
  // Для Claude → OpenAI
  toolCallIndexMap: Map<number, number>;  // Claude block index → OpenAI tool_call index
  nextToolCallIndex: number;
}
```

---

## Критические различия

1. **Claude разделяет события** - start/delta/stop для каждого блока
2. **OpenAI объединяет** - всё в одном chunk с delta
3. **Claude index** - глобальный для всех content blocks
4. **OpenAI index** - только для tool_calls внутри одного chunk
5. **Claude partial_json** - может быть пустой строкой в первом delta
6. **OpenAI arguments** - всегда строка, накапливается
