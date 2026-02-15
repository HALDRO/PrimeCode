<!-- Source: https://opencode.ai/docs/keybinds -->

## [Shift+Enter](https://opencode.ai/docs/keybinds#shiftenter)
Некоторые терминалы по умолчанию не отправляют клавиши-модификаторы с Enter. Возможно, вам придется настроить терминал на отправку `Shift+Enter` в качестве escape-последовательности.

### [Windows Terminal](https://opencode.ai/docs/keybinds#windows-terminal)
Откройте свой `settings.json` по адресу:
```

%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json

```

Добавьте это в массив `actions` корневого уровня:
```


"actions": [



{



"command": {




"action": "sendInput",




"input": "\u001b[13;2u"



},



"id": "User.sendInput.ShiftEnterCustom"



}


]

```

Добавьте это в массив `keybindings` корневого уровня:
```


"keybindings": [



{



"keys": "shift+enter",




"id": "User.sendInput.ShiftEnterCustom"



}


]

```

Сохраните файл и перезапустите Windows Terminal или откройте новую вкладку.
[](https://github.com/anomalyco/opencode/edit/dev/packages/web/src/content/docs/ru/keybinds.mdx)[](https://github.com/anomalyco/opencode/issues/new)[](https://opencode.ai/discord) Выберите язык English العربية Bosanski Dansk Deutsch Español Français Italiano 日本語 한국어 Norsk Bokmål Polski Português (Brasil) Русский ไทย Türkçe 简体中文 繁體中文
© [Anomaly](https://anoma.ly)
Последнее обновление: 14 февр. 2026 г.

