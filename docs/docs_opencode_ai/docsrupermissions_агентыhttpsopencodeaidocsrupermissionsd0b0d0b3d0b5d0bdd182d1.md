<!-- Source: https://opencode.ai/docs/ru/permissions -->

## [Агенты](https://opencode.ai/docs/ru/permissions#%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B)
Вы можете переопределить разрешения для каждого агента. Разрешения агента объединяются с глобальной конфигурацией, и правила агента имеют приоритет. [Подробнее](https://opencode.ai/docs/agents#permissions) о разрешениях агента.
Более подробные примеры сопоставления с образцом см. в разделе [Детальные правила (синтаксис объекта)](https://opencode.ai/docs/ru/permissions#granular-rules-object-syntax) выше.
opencode.json```

{



"$schema": "https://opencode.ai/config.json",




"permission": {




"bash": {




"*": "ask",




"git *": "allow",




"git commit *": "deny",




"git push *": "deny",




"grep *": "allow"



}


},



"agent": {




"build": {




"permission": {




"bash": {




"*": "ask",




"git *": "allow",




"git commit *": "ask",




"git push *": "deny",




"grep *": "allow"



}


}


}


}


}

```

Вы также можете настроить разрешения агента в Markdown:
~/.config/opencode/agents/review.md```

---



description: Code review without edits




mode: subagent




permission:




edit: deny




bash: ask




webfetch: deny



---


Only analyze code and suggest changes.

```

Используйте сопоставление с образцом для команд с аргументами. `"grep *"` разрешает `grep pattern file.txt`, а сам `"grep"` блокирует его. Такие команды, как `git status`, работают по умолчанию, но требуют явного разрешения (например, `"git status *"`) при передаче аргументов.
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/permissions.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

