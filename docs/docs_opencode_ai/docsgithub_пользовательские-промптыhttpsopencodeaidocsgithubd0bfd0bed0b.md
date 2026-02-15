<!-- Source: https://opencode.ai/docs/github -->

## [Пользовательские промпты](https://opencode.ai/docs/github#%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D0%BA%D0%B8%D0%B5-%D0%BF%D1%80%D0%BE%D0%BC%D0%BF%D1%82%D1%8B)
Переопределите приглашение по умолчанию, чтобы настроить поведение opencode для вашего рабочего процесса.
.github/workflows/opencode.yml```


- uses: anomalyco/opencode/github@latest




with:




model: anthropic/claude-sonnet-4-5




prompt: |



Review this pull request:


- Check for code quality issues


- Look for potential bugs


- Suggest improvements

```

Это полезно для обеспечения соблюдения конкретных критериев проверки, стандартов кодирования или приоритетных областей, имеющих отношение к вашему проекту.
* * *

