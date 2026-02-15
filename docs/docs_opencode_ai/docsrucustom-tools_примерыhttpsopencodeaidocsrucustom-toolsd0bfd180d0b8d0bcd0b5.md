<!-- Source: https://opencode.ai/docs/ru/custom-tools -->

## [Примеры](https://opencode.ai/docs/ru/custom-tools#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B)

### [Инструмент на Python](https://opencode.ai/docs/ru/custom-tools#%D0%B8%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BC%D0%B5%D0%BD%D1%82-%D0%BD%D0%B0-python)
Вы можете писать свои инструменты на любом языке, который захотите. Вот пример сложения двух чисел с использованием Python.
Сначала создайте инструмент как скрипт Python:
.opencode/tools/add.py```


import sys




a =int(sys.argv[1])




b =int(sys.argv[2])




print(a + b)


```

Затем создайте определение инструмента, которое его вызывает:
.opencode/tools/python-add.ts```


import { tool } from"@opencode-ai/plugin"




import path from"path"




exportdefaulttool({




description: "Add two numbers using Python",



args: {



a: tool.schema.number().describe("First number"),




b: tool.schema.number().describe("Second number"),



},



asyncexecute(args, context) {




constscript= path.join(context.worktree, ".opencode/tools/add.py")




constresult=await Bun.$`python3 ${script} ${args.a} ${args.b}`.text()




return result.trim()



},


})

```

Здесь мы используем утилиту [`Bun.$`](https://bun.com/docs/runtime/shell) для запуска скрипта Python.
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/custom-tools.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

